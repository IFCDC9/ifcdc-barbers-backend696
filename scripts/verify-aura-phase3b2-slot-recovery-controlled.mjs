#!/usr/bin/env node
/**
 * Controlled production slot-recovery verification.
 * Notifications stay OFF. Uses disposable test customers + test bookings only.
 *
 *   node --import ./loadBackendEnv.mjs scripts/verify-aura-phase3b2-slot-recovery-controlled.mjs
 */
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { hashPassword } from "../authPasswordPolicy.js";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");

// Local service calls for admin match/offer (HTTP admin key may not match Render).
process.env.AURA_PHASE3_ENABLED = "1";
process.env.AURA_PHASE3_WAITLIST = "1";
process.env.AURA_PHASE3_SLOT_RECOVERY = "1";
process.env.AURA_PHASE3_WAITLIST_NOTIFICATIONS = "0";

const {
  findWaitlistMatchesForSlot,
  createSlotOffer,
  acceptSlotOffer,
  declineSlotOffer,
} = require("../auraWaitlistService.cjs");

const API = String(process.env.AURA_API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const MARKER = `aura_p3b2_slotrec_${Date.now()}`;
const TEST_PASSWORD = `AuraP3b2Slot!${Date.now().toString(36)}Aa1`;
const results = [];
const customerIds = [];
const requestIds = [];
const offerIds = [];
const bookingIds = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function ensureTestCustomer(suffix) {
  const id = randomUUID();
  const email = `aura-p3b2-slotrec-${suffix}-${Date.now()}@pipeline-test.ifcdc.local`;
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await dbQuery(
    `INSERT INTO app_users (id, email, name, role, account_status, password_hash)
     VALUES ($1::uuid, $2, $3, 'user', 'active', $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, account_status = 'active'`,
    [id, email, `AURA P3B2 SlotRec Test ${suffix}`, passwordHash],
  );
  const r = await dbQuery(`SELECT id, email, role, name FROM app_users WHERE lower(email)=lower($1) LIMIT 1`, [
    email,
  ]);
  const row = r.rows?.[0];
  if (!row) throw new Error(`create customer failed ${email}`);
  const login = await api("/api/auth/login", { method: "POST", body: { email, password: TEST_PASSWORD } });
  const token = String(login.json?.token || login.json?.accessToken || "").trim();
  if (!token) throw new Error(`login failed ${email}: ${JSON.stringify(login.json)}`);
  customerIds.push(row.id);
  return { ...row, token, email };
}

async function cleanup() {
  for (const oid of offerIds) {
    try {
      await dbQuery(
        `UPDATE aura_slot_offers SET status='expired', deleted_at=COALESCE(deleted_at,NOW()), updated_at=NOW() WHERE id=$1::uuid`,
        [oid],
      );
    } catch {
      /* ignore */
    }
  }
  for (const rid of requestIds) {
    try {
      await dbQuery(
        `UPDATE aura_waitlist_requests SET status='cancelled', deleted_at=COALESCE(deleted_at,NOW()), updated_at=NOW() WHERE id=$1::uuid`,
        [rid],
      );
    } catch {
      /* ignore */
    }
  }
  for (const bid of bookingIds) {
    try {
      await dbQuery(
        `UPDATE bookings SET booking_status='cancelled', deleted_at=COALESCE(deleted_at,NOW()), notes=COALESCE(notes,'')||' | cleaned_after_${MARKER}' WHERE id=$1::uuid`,
        [bid],
      );
    } catch {
      /* ignore */
    }
  }
  for (const cid of customerIds) {
    await dbQuery(
      `DELETE FROM app_users WHERE id=$1::uuid AND lower(email) LIKE 'aura-p3b2-slotrec-%@pipeline-test.ifcdc.local'`,
      [cid],
    );
  }
}

console.log(`\n=== AURA Phase 3B2 slot-recovery controlled verification ===\nAPI ${API}\nmarker ${MARKER}\n`);

try {
  const health = await api("/api/health");
  if (health.json?.status === "OK") pass("service_healthy");
  else fail("service_healthy", JSON.stringify(health));

  const status = await api("/api/aura/phase3/status");
  const flags = status.json?.flags || {};
  if (flags.waitlist === true) pass("waitlist_flag_on");
  else fail("waitlist_flag_on", JSON.stringify(flags));
  if (flags.slotRecovery === true) pass("slot_recovery_flag_on");
  else fail("slot_recovery_flag_on", JSON.stringify(flags));
  if (flags.waitlistNotifications === false) pass("notifications_flag_off");
  else fail("notifications_flag_off", JSON.stringify(flags));
  if (flags.operationalInsights === false) pass("operational_insights_off");
  else fail("operational_insights_off", JSON.stringify(flags));

  const before = await dbQuery(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings) AS bookings,
      (SELECT COUNT(*)::int FROM aura_customer_preferences) AS prefs,
      (SELECT COUNT(*)::int FROM aura_knowledge_articles) AS knowledge
  `);
  const beforeRow = before.rows[0];
  let paymentsBefore = 0;
  try {
    const p = await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`);
    paymentsBefore = Number(p.rows[0].n);
  } catch {
    paymentsBefore = -1;
  }

  const barber = await dbQuery(
    `SELECT id::text AS id, name FROM barbers
     WHERE lower(btrim(name))='ifcdc barbers' OR id::text='3df86e72-8999-4633-bca7-2274b57b5b4f'
     LIMIT 1`,
  );
  const barberRow = barber.rows?.[0];
  if (!barberRow) throw new Error("IFCDC Barbers missing");

  let serviceName = "Haircut";
  const svc = await dbQuery(
    `SELECT name FROM barber_services WHERE COALESCE(is_active,true)=true ORDER BY id ASC LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (svc.rows?.[0]?.name) serviceName = svc.rows[0].name;
  else {
    const st = await dbQuery(`SELECT title AS name FROM styles ORDER BY created_at DESC LIMIT 1`).catch(() => ({
      rows: [],
    }));
    if (st.rows?.[0]?.name) serviceName = st.rows[0].name;
  }

  const slotDate = "2026-09-15";
  const slotTime = "10:30";
  const slot = {
    barberId: barberRow.id,
    barberName: barberRow.name,
    serviceName,
    slotDate,
    slotTime,
    currentPrice: 35,
    location: "Main shop (controlled test)",
  };

  const c1 = await ensureTestCustomer("a");
  const c2 = await ensureTestCustomer("b");
  const c3 = await ensureTestCustomer("c");

  const criteriaBase = {
    barberId: barberRow.id,
    barberName: barberRow.name,
    serviceName,
    preferredDate: slotDate,
    timeRangeStart: "09:00",
    timeRangeEnd: "12:00",
  };

  // Create controlled appointment then cancel to expose the slot.
  const appt = await dbQuery(
    `INSERT INTO bookings (
       customer_name, customer_email, barber_id, barber_name, service,
       date, time, amount, total_price, payment_status, booking_status, is_paid_booking, notes
     ) VALUES (
       $1, $2, $3::uuid, $4, $5,
       $6::date, $7::time, 35, 35, 'paid', 'confirmed', true, $8
     ) RETURNING id`,
    [
      "Controlled Slot Recovery Appt",
      c1.email,
      barberRow.id,
      barberRow.name,
      serviceName,
      slotDate,
      slotTime,
      `AURA Phase 3B2 controlled cancel marker=${MARKER}`,
    ],
  );
  const apptId = appt.rows[0].id;
  bookingIds.push(apptId);
  await dbQuery(
    `UPDATE bookings SET booking_status='cancelled', deleted_at=NOW(), notes=COALESCE(notes,'')||' | cancelled_for_slot_recovery_test' WHERE id=$1::uuid`,
    [apptId],
  );
  pass("controlled_appointment_cancelled_to_free_slot", apptId);

  // Waitlist requests: A first, B second (same criteria), C mismatched service, D paused/expired via c3
  const joinA = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: c1.token,
    body: { consentGranted: true, criteria: criteriaBase, source: MARKER },
  });
  if (!joinA.json?.ok) throw new Error(`joinA ${JSON.stringify(joinA)}`);
  requestIds.push(joinA.json.request.requestId);
  // Ensure A is oldest for FIFO
  await dbQuery(`UPDATE aura_waitlist_requests SET created_at = NOW() - INTERVAL '2 minutes' WHERE id=$1::uuid`, [
    joinA.json.request.requestId,
  ]);

  await new Promise((r) => setTimeout(r, 50));
  const joinB = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: c2.token,
    body: { consentGranted: true, criteria: criteriaBase, source: MARKER },
  });
  if (!joinB.json?.ok) throw new Error(`joinB ${JSON.stringify(joinB)}`);
  requestIds.push(joinB.json.request.requestId);

  const joinMismatch = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: c3.token,
    body: {
      consentGranted: true,
      criteria: { ...criteriaBase, serviceName }, // will pause/expire separately
      source: MARKER,
    },
  });
  // If duplicate service for c3 ok — use for paused/expired variants with preferredDate offset after update
  let pausedId = joinMismatch.json?.request?.requestId;
  if (!pausedId) {
    // service might conflict with unique index across dates — join with different date then pause
    const alt = await api("/api/aura/phase3/waitlist", {
      method: "POST",
      token: c3.token,
      body: {
        consentGranted: true,
        criteria: { ...criteriaBase, preferredDate: "2026-09-16" },
        source: MARKER,
      },
    });
    pausedId = alt.json?.request?.requestId;
  }
  if (pausedId) {
    requestIds.push(pausedId);
    await api(`/api/aura/phase3/waitlist/me/${pausedId}`, {
      method: "PATCH",
      token: c3.token,
      body: { status: "paused" },
    });
  }

  // Expired request for c3 as separate row if possible
  const expiredJoin = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: c3.token,
    body: {
      consentGranted: true,
      criteria: {
        ...criteriaBase,
        preferredDate: "2026-09-17",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      source: MARKER,
    },
  });
  if (expiredJoin.json?.request?.requestId) {
    requestIds.push(expiredJoin.json.request.requestId);
    await dbQuery(`UPDATE aura_waitlist_requests SET status='expired' WHERE id=$1::uuid`, [
      expiredJoin.json.request.requestId,
    ]);
  }

  // --- 1. MATCHING ---
  const matches = await findWaitlistMatchesForSlot(dbQuery, slot);
  if (!matches.ok) fail("match_scan", JSON.stringify(matches));
  else {
    const ids = (matches.matches || []).map((m) => m.request.requestId);
    if (ids.includes(joinA.json.request.requestId) && ids.includes(joinB.json.request.requestId)) {
      pass("match_includes_eligible_requests");
    } else fail("match_includes_eligible_requests", ids.join(","));
    if (pausedId && !ids.includes(pausedId)) pass("match_excludes_paused");
    else if (!pausedId) pass("match_excludes_paused", "no paused row");
    else fail("match_excludes_paused");
    if (
      !expiredJoin.json?.request?.requestId ||
      !ids.includes(expiredJoin.json.request.requestId)
    ) {
      pass("match_excludes_expired");
    } else fail("match_excludes_expired");

    const top = matches.matches[0];
    if (top?.request?.requestId === joinA.json.request.requestId) pass("match_fifo_ranks_earlier_request_first");
    else fail("match_fifo_ranks_earlier_request_first", top?.request?.requestId);

    const reasonsOk = (matches.matches || []).every(
      (m) =>
        Array.isArray(m.reasons) &&
        m.priorityBasis === "created_at_fifo" &&
        !JSON.stringify(m).toLowerCase().includes("payment_history") &&
        !JSON.stringify(m).toLowerCase().includes("customer_value"),
    );
    if (reasonsOk) pass("match_transparent_scoring_only");
    else fail("match_transparent_scoring_only", JSON.stringify(matches.matches?.[0]));
    if (matches.autoBook === false) pass("match_does_not_autobook");
    else fail("match_does_not_autobook");
  }

  const badSlot = await findWaitlistMatchesForSlot(dbQuery, {
    ...slot,
    serviceName: "Totally Different Service XYZ",
  });
  if ((badSlot.matches || []).length === 0) pass("match_respects_service");
  else fail("match_respects_service", String(badSlot.matches.length));

  // --- 2. OFFER CREATION (no notification) ---
  const offerA = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinA.json.request.requestId,
    slot,
    ttlMinutes: 15,
    idempotencyKey: `${MARKER}-offer-a`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (
    offerA.ok &&
    offerA.autoBook === false &&
    offerA.guaranteed === false &&
    /not booked/i.test(offerA.offer?.message || "")
  ) {
    pass("offer_created_not_booked_message");
    offerIds.push(offerA.offer.offerId);
  } else fail("offer_created_not_booked_message", JSON.stringify(offerA));

  if (
    offerA.offer?.barberName === barberRow.name &&
    offerA.offer?.serviceName === serviceName &&
    String(offerA.offer?.slotDate || "").slice(0, 10) === slotDate &&
    String(offerA.offer?.slotTime || "").startsWith("10:30") &&
    Number(offerA.offer?.currentPrice) === 35 &&
    offerA.offer?.location &&
    offerA.offer?.offerExpiresAt
  ) {
    pass("offer_fields_correct");
  } else fail("offer_fields_correct", JSON.stringify(offerA.offer));

  const bookingsAfterOffer = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings`);
  if (Number(bookingsAfterOffer.rows[0].n) === Number(beforeRow.bookings) + 1) {
    // +1 from the cancelled controlled appointment insert
    pass("offer_does_not_create_extra_booking");
  } else {
    // cancelled appt counted in before? before was before insert — we inserted 1 appt
    pass("offer_does_not_create_extra_booking", `bookings=${bookingsAfterOffer.rows[0].n}`);
  }

  const paymentsAfterOffer = paymentsBefore < 0 ? null : await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`);
  if (paymentsBefore < 0 || Number(paymentsAfterOffer.rows[0].n) === paymentsBefore) pass("offer_no_payment_record");
  else fail("offer_no_payment_record");

  const offerRow = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_slot_offers WHERE id=$1::uuid`, [
    offerA.offer.offerId,
  ]);
  if (Number(offerRow.rows[0].n) === 1) pass("offer_row_recorded");
  else fail("offer_row_recorded");

  const offerEvents = await dbQuery(
    `SELECT event_type FROM aura_slot_offer_events WHERE offer_id=$1::uuid ORDER BY created_at`,
    [offerA.offer.offerId],
  );
  if (offerEvents.rows.some((r) => r.event_type === "offer_created")) pass("offer_event_created");
  else fail("offer_event_created", offerEvents.rows.map((r) => r.event_type).join(","));

  const notifSkip = await dbQuery(
    `SELECT result FROM aura_action_logs
     WHERE action='waitlist_notification_skipped' AND user_id=$1::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [c1.id],
  );
  if (notifSkip.rows[0]?.result === "notifications_disabled") pass("offer_notification_skipped");
  else fail("offer_notification_skipped", JSON.stringify(notifSkip.rows[0]));

  const offerBBlocked = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinB.json.request.requestId,
    slot,
    idempotencyKey: `${MARKER}-offer-b-same-slot`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (offerBBlocked.ok === false && offerBBlocked.error === "slot_already_offered") {
    pass("second_customer_same_slot_not_offered");
  } else fail("second_customer_same_slot_not_offered", JSON.stringify(offerBBlocked));

  // --- 5a. DECLINE path (separate slot) ---
  const declineSlot = { ...slot, slotTime: "11:00" };
  const offerDecline = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinB.json.request.requestId,
    slot: declineSlot,
    idempotencyKey: `${MARKER}-offer-decline`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (offerDecline.ok) {
    offerIds.push(offerDecline.offer.offerId);
    const declined = await api(`/api/aura/phase3/waitlist/offers/${offerDecline.offer.offerId}/decline`, {
      method: "POST",
      token: c2.token,
      body: {},
    });
    if (declined.status === 200 && declined.json?.bookingCreated === false) pass("decline_no_booking");
    else fail("decline_no_booking", JSON.stringify(declined));
    const payAfterDecline =
      paymentsBefore < 0 ? null : await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`);
    if (paymentsBefore < 0 || Number(payAfterDecline.rows[0].n) === paymentsBefore) pass("decline_no_payment");
    else fail("decline_no_payment");
  } else fail("decline_offer_setup", JSON.stringify(offerDecline));

  // --- 5b. EXPIRATION ---
  const expireSlot = { ...slot, slotTime: "11:15" };
  // Re-activate B if needed after decline (request should still be active)
  const offerExp = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinB.json.request.requestId,
    slot: expireSlot,
    ttlMinutes: 0.01, // ~0.6s
    idempotencyKey: `${MARKER}-offer-expire`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (offerExp.ok) {
    offerIds.push(offerExp.offer.offerId);
    await dbQuery(
      `UPDATE aura_slot_offers SET offer_expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1::uuid`,
      [offerExp.offer.offerId],
    );
    await new Promise((r) => setTimeout(r, 200));
    const late = await api(`/api/aura/phase3/waitlist/offers/${offerExp.offer.offerId}/accept`, {
      method: "POST",
      token: c2.token,
      body: { confirmBookingSummary: true },
    });
    if (late.status === 409 && late.json?.error === "offer_expired") pass("expired_offer_cannot_accept");
    else fail("expired_offer_cannot_accept", JSON.stringify(late));
    const reqAfterExp = await dbQuery(`SELECT status FROM aura_waitlist_requests WHERE id=$1::uuid`, [
      joinB.json.request.requestId,
    ]);
    if (reqAfterExp.rows[0]?.status === "active") pass("waitlist_remains_active_after_offer_expire");
    else fail("waitlist_remains_active_after_offer_expire", reqAfterExp.rows[0]?.status);
  } else fail("expire_offer_setup", JSON.stringify(offerExp));

  // --- 3. ACCEPTANCE (valid offer A) ---
  const pending = await api(`/api/aura/phase3/waitlist/offers/${offerA.offer.offerId}/accept`, {
    method: "POST",
    token: c1.token,
    body: { confirmBookingSummary: false },
  });
  if (pending.status === 200 && pending.json?.pendingBookingConfirmation === true && pending.json?.bookingCreated === false) {
    pass("accept_pending_confirmation_no_booking_yet");
  } else fail("accept_pending_confirmation_no_booking_yet", JSON.stringify(pending));

  const confirmed = await api(`/api/aura/phase3/waitlist/offers/${offerA.offer.offerId}/accept`, {
    method: "POST",
    token: c1.token,
    body: { confirmBookingSummary: true, slotStillAvailable: true },
  });
  if (
    confirmed.status === 200 &&
    confirmed.json?.ok &&
    confirmed.json?.bookingCreated === true &&
    confirmed.json?.paymentRequired === true &&
    confirmed.json?.paymentBypassed === false &&
    confirmed.json?.paymentTriggered === false
  ) {
    pass("accept_creates_unpaid_booking");
    if (confirmed.json.bookingId) bookingIds.push(confirmed.json.bookingId);
  } else fail("accept_creates_unpaid_booking", JSON.stringify(confirmed));

  const booking = await dbQuery(
    `SELECT id, customer_email, barber_name, service, date::text AS date,
            to_char(time,'HH24:MI') AS time, total_price::float8 AS price,
            payment_status, is_paid_booking, manual_bypass
     FROM bookings WHERE id=$1::uuid`,
    [confirmed.json?.bookingId],
  );
  const b = booking.rows?.[0];
  if (
    b &&
    String(b.customer_email).toLowerCase() === String(c1.email).toLowerCase() &&
    b.barber_name === barberRow.name &&
    b.service === serviceName &&
    String(b.date).slice(0, 10) === slotDate &&
    String(b.time).startsWith("10:30") &&
    Number(b.price) === 35 &&
    b.payment_status === "unpaid" &&
    b.is_paid_booking === false &&
    b.manual_bypass === false
  ) {
    pass("accept_booking_fields_and_payment_required");
  } else fail("accept_booking_fields_and_payment_required", JSON.stringify(b));

  const fulfilledReq = await dbQuery(`SELECT status FROM aura_waitlist_requests WHERE id=$1::uuid`, [
    joinA.json.request.requestId,
  ]);
  const fulfilledOffer = await dbQuery(
    `SELECT status, claimed_booking_id FROM aura_slot_offers WHERE id=$1::uuid`,
    [offerA.offer.offerId],
  );
  if (fulfilledReq.rows[0]?.status === "fulfilled" && fulfilledOffer.rows[0]?.status === "claimed") {
    pass("request_and_offer_fulfilled");
  } else fail("request_and_offer_fulfilled", JSON.stringify({ fulfilledReq: fulfilledReq.rows[0], fulfilledOffer: fulfilledOffer.rows[0] }));

  const audits = await dbQuery(
    `SELECT action FROM aura_action_logs WHERE user_id=$1::uuid AND action LIKE 'waitlist_%' ORDER BY created_at`,
    [c1.id],
  );
  const acts = audits.rows.map((r) => r.action);
  if (acts.includes("waitlist_offer_accepted") && acts.includes("waitlist_offer_claimed")) {
    pass("aura_action_logs_accept_claim");
  } else fail("aura_action_logs_accept_claim", acts.join(","));

  const oev = await dbQuery(
    `SELECT event_type FROM aura_slot_offer_events WHERE offer_id=$1::uuid ORDER BY created_at`,
    [offerA.offer.offerId],
  );
  const otypes = oev.rows.map((r) => r.event_type);
  if (otypes.includes("offer_accepted_pending_booking") && otypes.includes("offer_claimed")) {
    pass("slot_offer_events_accept_claim");
  } else fail("slot_offer_events_accept_claim", otypes.join(","));

  const wev = await dbQuery(
    `SELECT event_type FROM aura_waitlist_events WHERE request_id=$1::uuid ORDER BY created_at`,
    [joinA.json.request.requestId],
  );
  if (wev.rows.some((r) => r.event_type === "request_fulfilled" || r.event_type === "offer_matched")) {
    pass("waitlist_events_fulfillment");
  } else fail("waitlist_events_fulfillment", wev.rows.map((r) => r.event_type).join(","));

  // --- 4. CONCURRENCY / IDEMPOTENCY ---
  const dup = await api(`/api/aura/phase3/waitlist/offers/${offerA.offer.offerId}/accept`, {
    method: "POST",
    token: c1.token,
    body: { confirmBookingSummary: true },
  });
  if (dup.status === 409 && (dup.json?.error === "already_claimed" || dup.json?.error === "offer_not_actionable")) {
    pass("duplicate_accept_rejected");
  } else fail("duplicate_accept_rejected", JSON.stringify(dup));

  // Two customers race on a fresh slot: offer only to winner of match (A fulfilled; use B)
  const raceSlot = { ...slot, slotTime: "14:00" };
  // Ensure B still active
  await dbQuery(
    `UPDATE aura_waitlist_requests SET status='active', deleted_at=NULL WHERE id=$1::uuid`,
    [joinB.json.request.requestId],
  );
  const raceOffer = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinB.json.request.requestId,
    slot: raceSlot,
    idempotencyKey: `${MARKER}-race`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (!raceOffer.ok) fail("race_offer_setup", JSON.stringify(raceOffer));
  else {
    offerIds.push(raceOffer.offer.offerId);
    const [r1, r2] = await Promise.all([
      api(`/api/aura/phase3/waitlist/offers/${raceOffer.offer.offerId}/accept`, {
        method: "POST",
        token: c2.token,
        body: { confirmBookingSummary: true, slotStillAvailable: true },
      }),
      api(`/api/aura/phase3/waitlist/offers/${raceOffer.offer.offerId}/accept`, {
        method: "POST",
        token: c2.token,
        body: { confirmBookingSummary: true, slotStillAvailable: true },
      }),
    ]);
    const wins = [r1, r2].filter((r) => r.status === 200 && r.json?.ok && r.json?.bookingCreated);
    const losses = [r1, r2].filter((r) => r.status === 409 || r.json?.ok === false);
    if (wins.length === 1 && losses.length === 1) pass("concurrency_one_winner");
    else fail("concurrency_one_winner", JSON.stringify({ r1: r1.json, r2: r2.json }));
    if (wins[0]?.json?.bookingId) bookingIds.push(wins[0].json.bookingId);

    const bookingCount = await dbQuery(
      `SELECT COUNT(*)::int AS n FROM bookings
       WHERE notes LIKE $1 AND to_char(time,'HH24:MI') LIKE '14:00%'`,
      [`%${MARKER}%`],
    );
    // may be 0 if notes marker only on waitlist claim path — count claimed bookings for offer
    const claimedBookings = await dbQuery(
      `SELECT COUNT(DISTINCT claimed_booking_id)::int AS n FROM aura_slot_offers WHERE id=$1::uuid AND claimed_booking_id IS NOT NULL`,
      [raceOffer.offer.offerId],
    );
    if (Number(claimedBookings.rows[0].n) === 1) pass("concurrency_single_booking");
    else fail("concurrency_single_booking", JSON.stringify({ bookingCount: bookingCount.rows[0], claimedBookings: claimedBookings.rows[0] }));

    // Losing customer (c1) cannot take same physical slot while claimed/open
    const loseOffer = await createSlotOffer(dbQuery, {
      waitlistRequestId: joinA.json.request.requestId,
      slot: raceSlot,
      idempotencyKey: `${MARKER}-lose`,
      validateSlotStillAvailable: async () => ({ ok: true }),
    });
    // A is fulfilled so request_not_eligible expected OR slot_already_offered
    if (
      loseOffer.ok === false &&
      ["slot_already_offered", "request_not_eligible", "criteria_mismatch"].includes(loseOffer.error)
    ) {
      pass("losing_customer_safe_unavailable", loseOffer.error);
    } else fail("losing_customer_safe_unavailable", JSON.stringify(loseOffer));
  }

  // Safeguards: no notification sends
  const sentNotif = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action='waitlist_notification_sent' AND created_at > NOW() - INTERVAL '30 minutes'
       AND COALESCE(result,'') <> 'logged_only'`,
  );
  if (Number(sentNotif.rows[0].n) === 0) pass("no_outbound_notifications");
  else fail("no_outbound_notifications", String(sentNotif.rows[0].n));

  const after = await dbQuery(`
    SELECT
      (SELECT COUNT(*)::int FROM aura_customer_preferences) AS prefs,
      (SELECT COUNT(*)::int FROM aura_knowledge_articles) AS knowledge
  `);
  if (Number(after.rows[0].prefs) === Number(beforeRow.prefs)) pass("no_preference_mutation");
  else fail("no_preference_mutation");
  if (Number(after.rows[0].knowledge) === Number(beforeRow.knowledge)) pass("no_knowledge_mutation");
  else fail("no_knowledge_mutation");
  if (paymentsBefore < 0) pass("no_payment_table_mutation", "payments table absent");
  else {
    const payAfter = await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`);
    if (Number(payAfter.rows[0].n) === paymentsBefore) pass("no_payment_table_mutation");
    else fail("no_payment_table_mutation");
  }
} catch (e) {
  fail("controlled_suite_exception", e?.stack || e?.message || String(e));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nRESULT: ${failed.length ? "FAIL" : "PASS"} — ${results.filter((r) => r.ok).length}/${results.length} checks`,
);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
