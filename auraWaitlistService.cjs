/**
 * Phase 3B2 waitlist + open-slot recovery.
 * Never auto-books or auto-charges. Notifications gated separately.
 */
const { randomUUID } = require("crypto");
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraWaitlistTables } = require("./auraWaitlistMigrations.cjs");
const {
  MAX_OFFERS_PER_CUSTOMER_PER_DAY,
  DEFAULT_OFFER_TTL_MINUTES,
  normalizeWaitlistCriteria,
  buildWaitlistConsentPrompt,
  assertAuthorizedWaitlistCatalog,
  scoreWaitlistMatch,
} = require("./auraWaitlistSecurity.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

function waitlistEnabled() {
  return Boolean(auraPhase3Flags().waitlist);
}
function slotRecoveryEnabled() {
  const f = auraPhase3Flags();
  return Boolean(f.waitlist && f.slotRecovery);
}
function notificationsEnabled() {
  const f = auraPhase3Flags();
  return Boolean(f.waitlist && f.waitlistNotifications);
}

function publicRequest(row) {
  if (!row) return null;
  return {
    requestId: row.id,
    customerId: row.customer_id,
    barberId: row.barber_id,
    barberName: row.barber_name,
    anyQualifiedBarber: row.any_qualified_barber,
    serviceId: row.service_id,
    serviceName: row.service_name,
    preferredDate: row.preferred_date,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    earliestAcceptableDate: row.earliest_acceptable_date,
    timeRangeStart: row.time_range_start,
    timeRangeEnd: row.time_range_end,
    earliestAvailable: row.earliest_available,
    matchFlexibility: row.match_flexibility,
    status: row.status,
    priorityBasis: row.priority_basis,
    consentStatus: row.consent_status,
    consentTimestamp: row.consent_timestamp,
    expiresAt: row.expires_at,
    criteriaSummary: row.criteria_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function publicOffer(row) {
  if (!row) return null;
  return {
    offerId: row.id,
    waitlistRequestId: row.waitlist_request_id,
    customerId: row.customer_id,
    barberId: row.barber_id,
    barberName: row.barber_name,
    serviceId: row.service_id,
    serviceName: row.service_name,
    slotDate: row.slot_date,
    slotTime: row.slot_time,
    currentPrice: row.current_price != null ? Number(row.current_price) : null,
    location: row.location,
    status: row.status,
    offerExpiresAt: row.offer_expires_at,
    claimedBookingId: row.claimed_booking_id,
    matchScore: row.match_score,
    matchReasons: row.match_reasons,
    message:
      row.status === "offered"
        ? `Optional open slot: ${row.barber_name || "barber"} / ${row.service_name || "service"} on ${row.slot_date} at ${row.slot_time}${
            row.current_price != null ? ` — $${Number(row.current_price).toFixed(2)}` : ""
          }${row.location ? ` at ${row.location}` : ""}. Expires ${row.offer_expires_at}. The slot is NOT booked until you confirm the full booking summary.`
        : null,
    acceptDeclineRequired: row.status === "offered",
    autoBook: false,
    guaranteed: false,
  };
}

async function recordRequestEvent(dbQuery, {
  requestId = null,
  customerId,
  eventType,
  snapshot = null,
  actor = "customer",
  actorUserId = null,
} = {}) {
  await dbQuery(
    `INSERT INTO aura_waitlist_events (
       request_id, customer_id, event_type, snapshot, actor, actor_user_id
     ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid)`,
    [
      requestId,
      customerId,
      String(eventType || "").slice(0, 80),
      snapshot ? JSON.stringify(snapshot) : null,
      String(actor || "customer").slice(0, 40),
      actorUserId,
    ],
  );
}

async function recordOfferEvent(dbQuery, {
  offerId = null,
  customerId,
  eventType,
  snapshot = null,
  actor = "aura",
  actorUserId = null,
} = {}) {
  await dbQuery(
    `INSERT INTO aura_slot_offer_events (
       offer_id, customer_id, event_type, snapshot, actor, actor_user_id
     ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid)`,
    [
      offerId,
      customerId,
      String(eventType || "").slice(0, 80),
      snapshot ? JSON.stringify(snapshot) : null,
      String(actor || "aura").slice(0, 40),
      actorUserId,
    ],
  );
}

/**
 * Notification stub — never sends unless waitlistNotifications flag is on.
 * Even when on, local/default path only logs intent (no production flood).
 */
async function maybeNotifyWaitlist(dbQuery, { customerId, kind, payload } = {}) {
  if (!notificationsEnabled()) {
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: customerId,
      action: "waitlist_notification_skipped",
      result: "notifications_disabled",
      metadata: { kind, payload },
    });
    return { ok: true, sent: false, reason: "notifications_disabled" };
  }
  const today = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM aura_action_logs
     WHERE user_id = $1::uuid
       AND action = 'waitlist_notification_sent'
       AND created_at::date = CURRENT_DATE`,
    [customerId],
  );
  if (Number(today.rows?.[0]?.c || 0) >= MAX_OFFERS_PER_CUSTOMER_PER_DAY) {
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: customerId,
      action: "waitlist_notification_skipped",
      result: "daily_cap",
      metadata: { kind, cap: MAX_OFFERS_PER_CUSTOMER_PER_DAY },
    });
    return { ok: true, sent: false, reason: "daily_cap" };
  }
  // Controlled path: log only (test recipients / no outbound mail until separately approved).
  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: customerId,
    action: "waitlist_notification_sent",
    result: "logged_only",
    metadata: { kind, payload, note: "outbound delivery not enabled in 3B2 local path" },
  });
  return { ok: true, sent: false, loggedOnly: true };
}

async function offerWaitlistConsent(dbQuery, { customerId, criteria } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  const normalized = normalizeWaitlistCriteria(criteria || {});
  if (!normalized.ok) return { ok: false, error: normalized.error };
  await ensureAuraWaitlistTables(dbQuery);
  const prompt = buildWaitlistConsentPrompt(normalized.value);
  await recordRequestEvent(dbQuery, {
    customerId,
    eventType: "consent_offered",
    snapshot: { criteria: normalized.value, prompt },
    actor: "aura",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: customerId,
    action: "waitlist_consent_offer",
    result: "offered",
    metadata: { prompt, criteriaSummary: normalized.value.criteriaSummary },
  });
  return {
    ok: true,
    requiresConsent: true,
    saved: false,
    createsBooking: false,
    chargesPayment: false,
    prompt,
    criteria: normalized.value,
  };
}

async function declineWaitlistConsent(dbQuery, { customerId } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraWaitlistTables(dbQuery);
  await recordRequestEvent(dbQuery, {
    customerId,
    eventType: "consent_declined",
    actor: "customer",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "waitlist_consent_decline",
    result: "declined",
  });
  return { ok: true, saved: false, consentStatus: "declined" };
}

async function listWaitlistRequests(dbQuery, { customerId, includeDeleted = false } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraWaitlistTables(dbQuery);
  const r = await dbQuery(
    `SELECT * FROM aura_waitlist_requests
     WHERE customer_id = $1::uuid
       AND ($2::boolean = TRUE OR deleted_at IS NULL)
     ORDER BY updated_at DESC
     LIMIT 50`,
    [customerId, includeDeleted],
  );
  return { ok: true, requests: (r.rows || []).map(publicRequest) };
}

async function getWaitlistRequestForCustomer(dbQuery, { requestId, customerId } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  if (!requestId || !customerId) return { ok: false, error: "request_and_customer_required" };
  await ensureAuraWaitlistTables(dbQuery);
  const r = await dbQuery(
    `SELECT * FROM aura_waitlist_requests
     WHERE id = $1::uuid AND customer_id = $2::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [requestId, customerId],
  );
  const row = r.rows?.[0];
  if (!row) return { ok: false, error: "not_found_or_forbidden" };
  return { ok: true, request: publicRequest(row) };
}

async function joinWaitlistWithConsent(dbQuery, {
  customerId,
  criteria,
  consentGranted = false,
  source = "api",
} = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  if (!consentGranted) {
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "waitlist_join_blocked",
      result: "consent_required",
    });
    return { ok: false, error: "consent_required", requiresConsent: true };
  }
  const normalized = normalizeWaitlistCriteria(criteria || {});
  if (!normalized.ok) return { ok: false, error: normalized.error };
  await ensureAuraWaitlistTables(dbQuery);
  const authorized = await assertAuthorizedWaitlistCatalog(dbQuery, normalized.value);
  if (!authorized.ok) {
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "waitlist_join_blocked",
      result: authorized.error,
    });
    return { ok: false, error: authorized.error };
  }

  const v = authorized.value;
  // Duplicate active/paused prevention — merge by refreshing existing row.
  const existing = await dbQuery(
    `SELECT * FROM aura_waitlist_requests
     WHERE customer_id = $1::uuid
       AND deleted_at IS NULL
       AND status IN ('active', 'paused', 'pending_consent')
       AND COALESCE(barber_id::text, '') = COALESCE($2::text, '')
       AND COALESCE(service_name, '') = COALESCE($3, '')
       AND COALESCE(preferred_date::text, '') = COALESCE($4::text, '')
       AND COALESCE(date_from::text, '') = COALESCE($5::text, '')
       AND COALESCE(date_to::text, '') = COALESCE($6::text, '')
       AND COALESCE(time_range_start, '') = COALESCE($7, '')
       AND COALESCE(time_range_end, '') = COALESCE($8, '')
       AND any_qualified_barber = $9
       AND earliest_available = $10
     LIMIT 1`,
    [
      customerId,
      v.barberId,
      v.serviceName,
      v.preferredDate,
      v.dateFrom,
      v.dateTo,
      v.timeRangeStart,
      v.timeRangeEnd,
      v.anyQualifiedBarber,
      v.earliestAvailable,
    ],
  );
  const now = new Date().toISOString();
  let row = existing.rows?.[0];
  if (row) {
    const upd = await dbQuery(
      `UPDATE aura_waitlist_requests SET
         status = 'active',
         consent_status = 'granted',
         consent_timestamp = COALESCE(consent_timestamp, $2::timestamptz),
         expires_at = COALESCE($3::timestamptz, expires_at),
         criteria_summary = $4,
         match_flexibility = $5::jsonb,
         updated_at = NOW()
       WHERE id = $1::uuid AND customer_id = $6::uuid
       RETURNING *`,
      [
        row.id,
        now,
        v.expiresAt,
        v.criteriaSummary,
        JSON.stringify(v.matchFlexibility),
        customerId,
      ],
    );
    row = upd.rows?.[0];
    await recordRequestEvent(dbQuery, {
      requestId: row.id,
      customerId,
      eventType: "request_merged",
      snapshot: publicRequest(row),
      actor: "customer",
      actorUserId: customerId,
    });
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "waitlist_request_merged",
      result: "merged",
      metadata: { requestId: row.id },
    });
  } else {
    const ins = await dbQuery(
      `INSERT INTO aura_waitlist_requests (
         customer_id, barber_id, barber_name, any_qualified_barber,
         service_id, service_name, preferred_date, date_from, date_to,
         earliest_acceptable_date, time_range_start, time_range_end, earliest_available,
         match_flexibility, status, priority_basis, consent_status, consent_timestamp,
         expires_at, criteria_summary, created_by, source, audit_metadata
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7::date, $8::date, $9::date,
         $10::date, $11, $12, $13,
         $14::jsonb, 'active', 'created_at_fifo', 'granted', $15::timestamptz,
         $16::timestamptz, $17, 'customer', $18, $19::jsonb
       )
       RETURNING *`,
      [
        customerId,
        v.barberId,
        v.barberName,
        v.anyQualifiedBarber,
        v.serviceId,
        v.serviceName,
        v.preferredDate,
        v.dateFrom,
        v.dateTo,
        v.earliestAcceptableDate,
        v.timeRangeStart,
        v.timeRangeEnd,
        v.earliestAvailable,
        JSON.stringify(v.matchFlexibility),
        now,
        v.expiresAt,
        v.criteriaSummary,
        String(source || "api").slice(0, 80),
        JSON.stringify({ createdAt: now }),
      ],
    );
    row = ins.rows?.[0];
    await recordRequestEvent(dbQuery, {
      requestId: row.id,
      customerId,
      eventType: "request_created",
      snapshot: publicRequest(row),
      actor: "customer",
      actorUserId: customerId,
    });
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "waitlist_request_created",
      result: "created",
      metadata: { requestId: row.id, criteriaSummary: v.criteriaSummary },
    });
  }

  return {
    ok: true,
    request: publicRequest(row),
    createsBooking: false,
    chargesPayment: false,
    overridesSchedule: false,
  };
}

async function updateWaitlistRequest(dbQuery, { requestId, customerId, criteria } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  const existing = await getWaitlistRequestForCustomer(dbQuery, { requestId, customerId });
  if (!existing.ok) return existing;
  const normalized = normalizeWaitlistCriteria(criteria || {});
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const authorized = await assertAuthorizedWaitlistCatalog(dbQuery, normalized.value);
  if (!authorized.ok) return { ok: false, error: authorized.error };
  const v = authorized.value;
  const upd = await dbQuery(
    `UPDATE aura_waitlist_requests SET
       barber_id = $2::uuid,
       barber_name = $3,
       any_qualified_barber = $4,
       service_id = $5,
       service_name = $6,
       preferred_date = $7::date,
       date_from = $8::date,
       date_to = $9::date,
       earliest_acceptable_date = $10::date,
       time_range_start = $11,
       time_range_end = $12,
       earliest_available = $13,
       match_flexibility = $14::jsonb,
       expires_at = COALESCE($15::timestamptz, expires_at),
       criteria_summary = $16,
       updated_at = NOW()
     WHERE id = $1::uuid AND customer_id = $17::uuid AND deleted_at IS NULL
     RETURNING *`,
    [
      requestId,
      v.barberId,
      v.barberName,
      v.anyQualifiedBarber,
      v.serviceId,
      v.serviceName,
      v.preferredDate,
      v.dateFrom,
      v.dateTo,
      v.earliestAcceptableDate,
      v.timeRangeStart,
      v.timeRangeEnd,
      v.earliestAvailable,
      JSON.stringify(v.matchFlexibility),
      v.expiresAt,
      v.criteriaSummary,
      customerId,
    ],
  );
  const row = upd.rows?.[0];
  if (!row) return { ok: false, error: "not_found_or_forbidden" };
  await recordRequestEvent(dbQuery, {
    requestId: row.id,
    customerId,
    eventType: "request_updated",
    snapshot: publicRequest(row),
    actor: "customer",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "waitlist_request_updated",
    result: "updated",
    metadata: { requestId: row.id },
  });
  return { ok: true, request: publicRequest(row) };
}

async function setWaitlistStatus(dbQuery, { requestId, customerId, status, actor = "customer" } = {}) {
  if (!waitlistEnabled()) return { ok: false, error: "aura_phase3_waitlist_disabled" };
  const allowed = new Set(["active", "paused", "cancelled"]);
  if (!allowed.has(status)) return { ok: false, error: "invalid_status" };
  const existing = await getWaitlistRequestForCustomer(dbQuery, { requestId, customerId });
  if (!existing.ok) return existing;
  const softDelete = status === "cancelled";
  const upd = await dbQuery(
    `UPDATE aura_waitlist_requests SET
       status = $2,
       deleted_at = CASE WHEN $3::boolean THEN NOW() ELSE deleted_at END,
       updated_at = NOW()
     WHERE id = $1::uuid AND customer_id = $4::uuid
     RETURNING *`,
    [requestId, status === "cancelled" ? "cancelled" : status, softDelete, customerId],
  );
  const row = upd.rows?.[0];
  await recordRequestEvent(dbQuery, {
    requestId: row.id,
    customerId,
    eventType: status === "paused" ? "request_paused" : status === "cancelled" ? "request_removed" : "request_resumed",
    snapshot: publicRequest(row),
    actor,
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor,
    userId: customerId,
    action: `waitlist_request_${status === "cancelled" ? "removed" : status}`,
    result: status,
    metadata: { requestId: row.id },
  });
  return { ok: true, request: publicRequest(row) };
}

function isRequestEligible(row, now = new Date()) {
  if (!row || row.deleted_at) return false;
  if (row.status !== "active") return false;
  if (row.consent_status !== "granted") return false;
  if (row.expires_at && new Date(row.expires_at) < now) return false;
  return true;
}

/**
 * Find eligible waitlist matches for a freed slot. Does not create bookings or send mail.
 */
async function findWaitlistMatchesForSlot(dbQuery, slot = {}) {
  if (!slotRecoveryEnabled()) {
    return { ok: false, error: "aura_phase3_slot_recovery_disabled", matches: [] };
  }
  await ensureAuraWaitlistTables(dbQuery);
  // Expire stale active requests first.
  await dbQuery(
    `UPDATE aura_waitlist_requests
     SET status = 'expired', updated_at = NOW()
     WHERE deleted_at IS NULL AND status = 'active'
       AND expires_at IS NOT NULL AND expires_at < NOW()`,
  );
  const r = await dbQuery(
    `SELECT * FROM aura_waitlist_requests
     WHERE deleted_at IS NULL AND status = 'active' AND consent_status = 'granted'
     ORDER BY created_at ASC
     LIMIT 200`,
  );
  const matches = [];
  for (const row of r.rows || []) {
    if (!isRequestEligible(row)) continue;
    const scored = scoreWaitlistMatch(row, slot);
    if (!scored.eligible) continue;
    matches.push({
      request: publicRequest(row),
      score: scored.score,
      reasons: scored.reasons,
      priorityBasis: "created_at_fifo",
      createdAt: row.created_at,
    });
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  await logAuraAction(dbQuery, {
    actor: "aura",
    action: "waitlist_match_scan",
    result: matches.length ? "matches_found" : "none",
    metadata: {
      slot,
      matchCount: matches.length,
      top: matches.slice(0, 5).map((m) => ({
        requestId: m.request.requestId,
        score: m.score,
        reasons: m.reasons,
      })),
    },
  });
  return { ok: true, matches, autoBook: false };
}

/**
 * Create a controlled offer for one eligible request. Does not book/charge/guarantee.
 * Revalidates slot via provided validator callback.
 */
async function createSlotOffer(dbQuery, {
  waitlistRequestId,
  slot,
  validateSlotStillAvailable,
  ttlMinutes = DEFAULT_OFFER_TTL_MINUTES,
  idempotencyKey = null,
} = {}) {
  if (!slotRecoveryEnabled()) return { ok: false, error: "aura_phase3_slot_recovery_disabled" };
  await ensureAuraWaitlistTables(dbQuery);

  if (typeof validateSlotStillAvailable === "function") {
    const valid = await validateSlotStillAvailable(slot);
    if (!valid?.ok) {
      await logAuraAction(dbQuery, {
        actor: "aura",
        action: "waitlist_offer_blocked",
        result: "slot_revalidation_failed",
        metadata: { slot, reason: valid?.reason || "unavailable" },
      });
      return { ok: false, error: "slot_unavailable", reason: valid?.reason || "unavailable" };
    }
  }

  const reqRow = await dbQuery(
    `SELECT * FROM aura_waitlist_requests WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
    [waitlistRequestId],
  );
  const request = reqRow.rows?.[0];
  if (!request || !isRequestEligible(request)) {
    return { ok: false, error: "request_not_eligible" };
  }

  const scored = scoreWaitlistMatch(request, slot);
  if (!scored.eligible) return { ok: false, error: "criteria_mismatch", reasons: scored.reasons };

  const key = idempotencyKey || `offer:${waitlistRequestId}:${slot.barberId || ""}:${slot.slotDate}:${slot.slotTime}`;
  const existing = await dbQuery(
    `SELECT * FROM aura_slot_offers WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  if (existing.rows?.[0]) {
    return { ok: true, offer: publicOffer(existing.rows[0]), idempotent: true, autoBook: false };
  }

  // Do not tell multiple customers a slot is guaranteed — only one open offer per physical slot.
  const open = await dbQuery(
    `SELECT id FROM aura_slot_offers
     WHERE deleted_at IS NULL
       AND status IN ('offered', 'accepted_pending_booking', 'claimed')
       AND COALESCE(barber_id::text, '') = COALESCE($1::text, '')
       AND slot_date = $2::date
       AND slot_time = $3
       AND COALESCE(service_name, '') = COALESCE($4, '')
     LIMIT 1`,
    [slot.barberId || null, slot.slotDate, slot.slotTime, slot.serviceName || null],
  );
  if (open.rows?.[0]) {
    return { ok: false, error: "slot_already_offered" };
  }

  const expires = new Date(Date.now() + Number(ttlMinutes || DEFAULT_OFFER_TTL_MINUTES) * 60 * 1000).toISOString();
  const ins = await dbQuery(
    `INSERT INTO aura_slot_offers (
       waitlist_request_id, customer_id, barber_id, barber_name, service_id, service_name,
       slot_date, slot_time, current_price, location, status, offer_expires_at,
       match_score, match_reasons, idempotency_key, audit_metadata
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
       $7::date, $8, $9, $10, 'offered', $11::timestamptz,
       $12, $13::jsonb, $14, $15::jsonb
     )
     RETURNING *`,
    [
      waitlistRequestId,
      request.customer_id,
      slot.barberId || null,
      slot.barberName || null,
      slot.serviceId || null,
      slot.serviceName || null,
      slot.slotDate,
      slot.slotTime,
      slot.currentPrice ?? null,
      slot.location || null,
      expires,
      scored.score,
      JSON.stringify(scored.reasons),
      key,
      JSON.stringify({ createdAt: new Date().toISOString() }),
    ],
  );
  const offer = ins.rows?.[0];
  await recordOfferEvent(dbQuery, {
    offerId: offer.id,
    customerId: offer.customer_id,
    eventType: "offer_created",
    snapshot: publicOffer(offer),
  });
  await recordRequestEvent(dbQuery, {
    requestId: waitlistRequestId,
    customerId: offer.customer_id,
    eventType: "offer_matched",
    snapshot: publicOffer(offer),
  });
  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: offer.customer_id,
    action: "waitlist_offer_created",
    result: "offered",
    metadata: {
      offerId: offer.id,
      waitlistRequestId,
      expires,
      guaranteed: false,
      autoBook: false,
    },
  });
  await maybeNotifyWaitlist(dbQuery, {
    customerId: offer.customer_id,
    kind: "slot_offer",
    payload: publicOffer(offer),
  });
  return { ok: true, offer: publicOffer(offer), autoBook: false, guaranteed: false };
}

async function listOffersForCustomer(dbQuery, { customerId } = {}) {
  if (!slotRecoveryEnabled()) return { ok: false, error: "aura_phase3_slot_recovery_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraWaitlistTables(dbQuery);
  await dbQuery(
    `UPDATE aura_slot_offers SET status = 'expired', updated_at = NOW()
     WHERE customer_id = $1::uuid AND status = 'offered' AND offer_expires_at < NOW()`,
    [customerId],
  );
  const r = await dbQuery(
    `SELECT * FROM aura_slot_offers
     WHERE customer_id = $1::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 50`,
    [customerId],
  );
  return { ok: true, offers: (r.rows || []).map(publicOffer) };
}

async function declineSlotOffer(dbQuery, { offerId, customerId } = {}) {
  if (!slotRecoveryEnabled()) return { ok: false, error: "aura_phase3_slot_recovery_disabled" };
  const r = await dbQuery(
    `UPDATE aura_slot_offers SET status = 'declined', updated_at = NOW()
     WHERE id = $1::uuid AND customer_id = $2::uuid AND status = 'offered' AND deleted_at IS NULL
     RETURNING *`,
    [offerId, customerId],
  );
  const row = r.rows?.[0];
  if (!row) return { ok: false, error: "not_found_or_forbidden" };
  await recordOfferEvent(dbQuery, {
    offerId: row.id,
    customerId,
    eventType: "offer_declined",
    snapshot: publicOffer(row),
    actor: "customer",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "waitlist_offer_declined",
    result: "declined",
    metadata: { offerId: row.id },
  });
  return { ok: true, offer: publicOffer(row), bookingCreated: false };
}

/**
 * Atomic accept: only one customer/claim can win.
 * Does NOT create a booking yet — returns bookingSummaryPending confirmation requirement.
 */
async function acceptSlotOffer(dbQuery, {
  offerId,
  customerId,
  validateSlotStillAvailable,
  confirmBookingSummary = false,
  bookingId = null,
} = {}) {
  if (!slotRecoveryEnabled()) return { ok: false, error: "aura_phase3_slot_recovery_disabled" };
  await ensureAuraWaitlistTables(dbQuery);

  const current = await dbQuery(
    `SELECT * FROM aura_slot_offers
     WHERE id = $1::uuid AND customer_id = $2::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [offerId, customerId],
  );
  const offer = current.rows?.[0];
  if (!offer) return { ok: false, error: "not_found_or_forbidden" };
  if (offer.status === "claimed") {
    return { ok: false, error: "already_claimed", offer: publicOffer(offer) };
  }
  if (offer.status === "accepted_pending_booking" && confirmBookingSummary) {
    if (!offer.claim_token) return { ok: false, error: "claim_token_missing" };
    const fulfilled = await dbQuery(
      `UPDATE aura_slot_offers SET
         status = 'claimed',
         claimed_booking_id = $2::uuid,
         updated_at = NOW()
       WHERE id = $1::uuid
         AND customer_id = $3::uuid
         AND status = 'accepted_pending_booking'
         AND claim_token = $4::uuid
       RETURNING *`,
      [offerId, bookingId, customerId, offer.claim_token],
    );
    const done = fulfilled.rows?.[0];
    if (!done) return { ok: false, error: "claim_finalize_failed" };
    await dbQuery(
      `UPDATE aura_waitlist_requests SET status = 'fulfilled', updated_at = NOW()
       WHERE id = $1::uuid AND customer_id = $2::uuid`,
      [done.waitlist_request_id, customerId],
    );
    await recordOfferEvent(dbQuery, {
      offerId,
      customerId,
      eventType: "offer_claimed",
      snapshot: publicOffer(done),
      actor: "customer",
      actorUserId: customerId,
    });
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "waitlist_offer_claimed",
      result: "claimed",
      bookingId,
      metadata: { offerId, bookingId, paymentBypassed: false },
    });
    return {
      ok: true,
      bookingCreated: Boolean(bookingId),
      paymentTriggered: false,
      autoBook: false,
      offer: publicOffer(done),
      message: bookingId
        ? "Slot claim recorded against the confirmed booking."
        : "Claim reserved. Create the booking through the existing booking/payment flow.",
    };
  }
  if (offer.status !== "offered") {
    return { ok: false, error: "offer_not_actionable", status: offer.status };
  }
  if (new Date(offer.offer_expires_at) < new Date()) {
    await dbQuery(`UPDATE aura_slot_offers SET status='expired', updated_at=NOW() WHERE id=$1::uuid`, [
      offerId,
    ]);
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: customerId,
      action: "waitlist_offer_expired",
      result: "expired",
      metadata: { offerId },
    });
    return { ok: false, error: "offer_expired" };
  }

  const slot = {
    barberId: offer.barber_id,
    barberName: offer.barber_name,
    serviceName: offer.service_name,
    slotDate: offer.slot_date,
    slotTime: offer.slot_time,
    currentPrice: offer.current_price,
    location: offer.location,
  };
  if (typeof validateSlotStillAvailable === "function") {
    const valid = await validateSlotStillAvailable(slot);
    if (!valid?.ok) {
      await dbQuery(
        `UPDATE aura_slot_offers SET status='unavailable', updated_at=NOW() WHERE id=$1::uuid`,
        [offerId],
      );
      await logAuraAction(dbQuery, {
        actor: "aura",
        userId: customerId,
        action: "waitlist_offer_unavailable",
        result: "revalidation_failed",
        metadata: { offerId, reason: valid?.reason },
      });
      return {
        ok: false,
        error: "slot_unavailable",
        message: "That slot is no longer available.",
      };
    }
  }

  // Atomic claim lock on this offer row.
  const claimToken = randomUUID();
  const claimed = await dbQuery(
    `UPDATE aura_slot_offers SET
       status = 'accepted_pending_booking',
       claim_token = $3::uuid,
       updated_at = NOW()
     WHERE id = $1::uuid
       AND customer_id = $2::uuid
       AND status = 'offered'
       AND offer_expires_at > NOW()
       AND deleted_at IS NULL
     RETURNING *`,
    [offerId, customerId, claimToken],
  );
  const locked = claimed.rows?.[0];
  if (!locked) {
    return {
      ok: false,
      error: "claim_conflict",
      message: "Another acceptance already claimed this offer.",
    };
  }

  // Also block other open offers for the same physical slot.
  await dbQuery(
    `UPDATE aura_slot_offers SET status = 'superseded', updated_at = NOW()
     WHERE id <> $1::uuid
       AND deleted_at IS NULL
       AND status IN ('offered', 'accepted_pending_booking')
       AND COALESCE(barber_id::text, '') = COALESCE($2::text, '')
       AND slot_date = $3::date
       AND slot_time = $4
       AND COALESCE(service_name, '') = COALESCE($5, '')`,
    [offerId, offer.barber_id, offer.slot_date, offer.slot_time, offer.service_name],
  );

  await recordOfferEvent(dbQuery, {
    offerId,
    customerId,
    eventType: "offer_accepted_pending_booking",
    snapshot: publicOffer(locked),
    actor: "customer",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "waitlist_offer_accepted",
    result: "pending_booking_confirmation",
    metadata: {
      offerId,
      claimToken,
      autoBook: false,
      requiresBookingSummaryConfirm: true,
    },
  });

  if (!confirmBookingSummary) {
    return {
      ok: true,
      pendingBookingConfirmation: true,
      bookingCreated: false,
      paymentTriggered: false,
      autoBook: false,
      offer: publicOffer(locked),
      bookingSummary: {
        barberName: locked.barber_name,
        serviceName: locked.service_name,
        date: locked.slot_date,
        time: locked.slot_time,
        price: locked.current_price != null ? Number(locked.current_price) : null,
        location: locked.location,
      },
      message:
        "Confirm the full booking summary to create the appointment. Payment rules still apply. This is not booked yet.",
    };
  }

  // Final fulfillment mark only after explicit booking summary confirmation.
  // Actual booking insert remains outside this module (existing booking/payment workflows).
  const fulfilled = await dbQuery(
    `UPDATE aura_slot_offers SET
       status = 'claimed',
       claimed_booking_id = $2::uuid,
       updated_at = NOW()
     WHERE id = $1::uuid
       AND customer_id = $3::uuid
       AND status = 'accepted_pending_booking'
       AND claim_token = $4::uuid
     RETURNING *`,
    [offerId, bookingId, customerId, claimToken],
  );
  const done = fulfilled.rows?.[0];
  if (!done) return { ok: false, error: "claim_finalize_failed" };

  await dbQuery(
    `UPDATE aura_waitlist_requests SET status = 'fulfilled', updated_at = NOW()
     WHERE id = $1::uuid AND customer_id = $2::uuid`,
    [done.waitlist_request_id, customerId],
  );
  await recordOfferEvent(dbQuery, {
    offerId,
    customerId,
    eventType: "offer_claimed",
    snapshot: publicOffer(done),
    actor: "customer",
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "waitlist_offer_claimed",
    result: "claimed",
    bookingId,
    metadata: { offerId, bookingId, paymentBypassed: false },
  });

  return {
    ok: true,
    bookingCreated: Boolean(bookingId),
    paymentTriggered: false,
    autoBook: false,
    offer: publicOffer(done),
    message: bookingId
      ? "Slot claim recorded against the confirmed booking."
      : "Claim reserved. Create the booking through the existing booking/payment flow.",
  };
}

/**
 * Two-customer race helper for tests: attempt claim; loser gets safe unavailable.
 */
async function attemptExclusiveSlotClaim(dbQuery, args) {
  return acceptSlotOffer(dbQuery, args);
}

module.exports = {
  waitlistEnabled,
  slotRecoveryEnabled,
  notificationsEnabled,
  offerWaitlistConsent,
  declineWaitlistConsent,
  listWaitlistRequests,
  getWaitlistRequestForCustomer,
  joinWaitlistWithConsent,
  updateWaitlistRequest,
  setWaitlistStatus,
  findWaitlistMatchesForSlot,
  createSlotOffer,
  listOffersForCustomer,
  declineSlotOffer,
  acceptSlotOffer,
  attemptExclusiveSlotClaim,
  maybeNotifyWaitlist,
  publicRequest,
  publicOffer,
  isRequestEligible,
};
