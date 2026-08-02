/**
 * Phase 3B1 customer preferences — consent-gated, ownership-enforced, no auto-booking.
 */
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraPreferenceTables } = require("./auraPreferenceMigrations.cjs");
const {
  isAllowedPreferenceType,
  normalizePreferenceValue,
  preferencesCannotOverrideScheduling,
  sanitizeCustomerText,
} = require("./auraPreferenceSecurity.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

function prefsEnabled() {
  return Boolean(auraPhase3Flags().customerPreferences);
}

function suggestionsEnabled() {
  const f = auraPhase3Flags();
  return Boolean(f.customerPreferences && f.preferenceSuggestions);
}

function publicPreference(row) {
  if (!row) return null;
  return {
    preferenceId: row.id,
    customerId: row.customer_id,
    preferenceType: row.preference_type,
    preferenceValue: row.preference_value,
    consentStatus: row.consent_status,
    consentTimestamp: row.consent_timestamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    createdBy: row.created_by,
    source: row.source,
  };
}

async function recordEvent(dbQuery, {
  preferenceId = null,
  customerId,
  eventType,
  preferenceType = null,
  snapshot = null,
  actor = "customer",
  actorUserId = null,
} = {}) {
  await dbQuery(
    `INSERT INTO aura_customer_preference_events (
       preference_id, customer_id, event_type, preference_type, snapshot, actor, actor_user_id
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid)`,
    [
      preferenceId,
      customerId,
      String(eventType || "").slice(0, 80),
      preferenceType,
      snapshot ? JSON.stringify(snapshot) : null,
      String(actor || "customer").slice(0, 40),
      actorUserId,
    ],
  );
}

function buildConsentPrompt({ preferenceType, preferenceValue }) {
  if (preferenceType === "preferred_barber") {
    const name = preferenceValue?.barberName || "this barber";
    return `Would you like me to remember that you prefer appointments with ${name}?`;
  }
  if (preferenceType === "preferred_days" && preferenceValue?.days?.length) {
    const days = preferenceValue.days.join(", ");
    return `Would you like me to remember that you prefer ${days} appointments?`;
  }
  if (preferenceType === "preferred_time_ranges" && preferenceValue?.ranges?.length) {
    const r = preferenceValue.ranges[0];
    return `Would you like me to remember that you prefer ${r.start}–${r.end} appointments?`;
  }
  if (preferenceType === "preferred_services" && preferenceValue?.services?.length) {
    return `Would you like me to remember that you prefer ${preferenceValue.services.join(", ")}?`;
  }
  if (preferenceType === "preferred_language") {
    return `Would you like me to remember that you prefer ${preferenceValue.language}?`;
  }
  if (preferenceType === "communication_preference") {
    return `Would you like me to remember your communication preference (${preferenceValue.channel})?`;
  }
  if (preferenceType === "accessibility_notes") {
    return `Would you like me to remember the service note you shared for future visits?`;
  }
  return "Would you like me to remember this preference for future visits?";
}

/**
 * Offer to save a preference — does not persist preference rows until consent is granted.
 */
async function offerPreferenceConsent(dbQuery, {
  customerId,
  preferenceType,
  preferenceValue,
  actor = "aura",
} = {}) {
  if (!prefsEnabled()) {
    return { ok: false, error: "aura_phase3_preferences_disabled" };
  }
  if (!customerId) return { ok: false, error: "customer_required" };
  if (!isAllowedPreferenceType(preferenceType)) {
    return { ok: false, error: "unauthorized_preference_type" };
  }
  const normalized = normalizePreferenceValue(preferenceType, preferenceValue);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  await ensureAuraPreferenceTables(dbQuery);
  const prompt = buildConsentPrompt({
    preferenceType,
    preferenceValue: normalized.value,
  });
  await recordEvent(dbQuery, {
    customerId,
    eventType: "consent_offered",
    preferenceType,
    snapshot: { preferenceValue: normalized.value, prompt },
    actor,
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor,
    userId: customerId,
    action: "preference_consent_offer",
    result: "offered",
    metadata: { preferenceType, prompt },
  });
  return {
    ok: true,
    requiresConsent: true,
    saved: false,
    prompt,
    preferenceType,
    preferenceValue: normalized.value,
    overrides: preferencesCannotOverrideScheduling(),
  };
}

async function declinePreferenceConsent(dbQuery, {
  customerId,
  preferenceType = null,
  actor = "customer",
} = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraPreferenceTables(dbQuery);
  await recordEvent(dbQuery, {
    customerId,
    eventType: "consent_declined",
    preferenceType,
    actor,
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor,
    userId: customerId,
    action: "preference_consent_decline",
    result: "declined",
    metadata: { preferenceType },
  });
  return { ok: true, consentStatus: "declined", saved: false };
}

async function listCustomerPreferences(dbQuery, { customerId, includeDeleted = false } = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraPreferenceTables(dbQuery);
  const r = await dbQuery(
    `SELECT * FROM aura_customer_preferences
     WHERE customer_id = $1::uuid
       AND ($2::boolean = TRUE OR deleted_at IS NULL)
     ORDER BY updated_at DESC
     LIMIT 50`,
    [customerId, includeDeleted],
  );
  return { ok: true, preferences: (r.rows || []).map(publicPreference) };
}

async function getPreferenceForCustomer(dbQuery, { preferenceId, customerId } = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!preferenceId || !customerId) return { ok: false, error: "preference_and_customer_required" };
  await ensureAuraPreferenceTables(dbQuery);
  const r = await dbQuery(
    `SELECT * FROM aura_customer_preferences
     WHERE id = $1::uuid AND customer_id = $2::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [preferenceId, customerId],
  );
  const row = r.rows?.[0];
  if (!row) return { ok: false, error: "not_found_or_forbidden" };
  return { ok: true, preference: publicPreference(row) };
}

/**
 * Save or update a preference only after explicit consent.
 * consentGranted must be true — ordinary conversation never saves.
 */
async function savePreferenceWithConsent(dbQuery, {
  customerId,
  preferenceType,
  preferenceValue,
  consentGranted = false,
  source = "aura_chat",
  createdBy = "customer",
  actorUserId = null,
} = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  if (!consentGranted) {
    await logAuraAction(dbQuery, {
      actor: createdBy,
      userId: customerId,
      action: "preference_save_blocked",
      result: "consent_required",
      metadata: { preferenceType },
    });
    return { ok: false, error: "consent_required", requiresConsent: true };
  }
  if (!isAllowedPreferenceType(preferenceType)) {
    return { ok: false, error: "unauthorized_preference_type" };
  }
  const normalized = normalizePreferenceValue(preferenceType, preferenceValue);
  if (!normalized.ok) {
    await logAuraAction(dbQuery, {
      actor: createdBy,
      userId: customerId,
      action: "preference_save_blocked",
      result: normalized.error,
      metadata: { preferenceType },
    });
    return { ok: false, error: normalized.error };
  }

  await ensureAuraPreferenceTables(dbQuery);
  const existing = await dbQuery(
    `SELECT * FROM aura_customer_preferences
     WHERE customer_id = $1::uuid
       AND preference_type = $2
       AND deleted_at IS NULL
       AND consent_status = 'granted'
     LIMIT 1`,
    [customerId, preferenceType],
  );
  const prev = existing.rows?.[0];
  const now = new Date().toISOString();
  let row;

  if (prev) {
    const upd = await dbQuery(
      `UPDATE aura_customer_preferences SET
         preference_value = $2::jsonb,
         consent_status = 'granted',
         consent_timestamp = COALESCE(consent_timestamp, $3::timestamptz),
         updated_at = NOW(),
         source = $4,
         audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $5::jsonb
       WHERE id = $1::uuid AND customer_id = $6::uuid AND deleted_at IS NULL
       RETURNING *`,
      [
        prev.id,
        JSON.stringify(normalized.value),
        now,
        String(source || "aura_chat").slice(0, 80),
        JSON.stringify({ lastAction: "updated", at: now }),
        customerId,
      ],
    );
    row = upd.rows?.[0];
    await recordEvent(dbQuery, {
      preferenceId: row?.id,
      customerId,
      eventType: "preference_updated",
      preferenceType,
      snapshot: publicPreference(row),
      actor: createdBy,
      actorUserId: actorUserId || customerId,
    });
    await logAuraAction(dbQuery, {
      actor: createdBy,
      userId: customerId,
      action: "preference_updated",
      result: "updated",
      metadata: { preferenceId: row?.id, preferenceType },
    });
  } else {
    const ins = await dbQuery(
      `INSERT INTO aura_customer_preferences (
         customer_id, preference_type, preference_value, consent_status, consent_timestamp,
         created_by, source, audit_metadata
       ) VALUES (
         $1::uuid, $2, $3::jsonb, 'granted', $4::timestamptz, $5, $6, $7::jsonb
       )
       RETURNING *`,
      [
        customerId,
        preferenceType,
        JSON.stringify(normalized.value),
        now,
        String(createdBy || "customer").slice(0, 40),
        String(source || "aura_chat").slice(0, 80),
        JSON.stringify({ lastAction: "created", at: now }),
      ],
    );
    row = ins.rows?.[0];
    await recordEvent(dbQuery, {
      preferenceId: row?.id,
      customerId,
      eventType: "preference_created",
      preferenceType,
      snapshot: publicPreference(row),
      actor: createdBy,
      actorUserId: actorUserId || customerId,
    });
    await logAuraAction(dbQuery, {
      actor: createdBy,
      userId: customerId,
      action: "preference_created",
      result: "created",
      metadata: { preferenceId: row?.id, preferenceType },
    });
  }

  return {
    ok: true,
    preference: publicPreference(row),
    overrides: preferencesCannotOverrideScheduling(),
    autoBook: false,
  };
}

async function deletePreference(dbQuery, {
  preferenceId,
  customerId,
  actor = "customer",
  actorUserId = null,
  adminOverride = false,
} = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!preferenceId) return { ok: false, error: "preference_id_required" };
  await ensureAuraPreferenceTables(dbQuery);

  let row;
  if (adminOverride) {
    const r = await dbQuery(
      `SELECT * FROM aura_customer_preferences WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
      [preferenceId],
    );
    row = r.rows?.[0];
  } else {
    if (!customerId) return { ok: false, error: "customer_required" };
    const r = await dbQuery(
      `SELECT * FROM aura_customer_preferences
       WHERE id = $1::uuid AND customer_id = $2::uuid AND deleted_at IS NULL
       LIMIT 1`,
      [preferenceId, customerId],
    );
    row = r.rows?.[0];
  }
  if (!row) return { ok: false, error: "not_found_or_forbidden" };

  const upd = await dbQuery(
    `UPDATE aura_customer_preferences
     SET deleted_at = NOW(), updated_at = NOW(), consent_status = 'withdrawn'
     WHERE id = $1::uuid
     RETURNING *`,
    [row.id],
  );
  const deleted = upd.rows?.[0];
  await recordEvent(dbQuery, {
    preferenceId: deleted.id,
    customerId: deleted.customer_id,
    eventType: "preference_deleted",
    preferenceType: deleted.preference_type,
    snapshot: publicPreference(deleted),
    actor,
    actorUserId: actorUserId || customerId,
  });
  await logAuraAction(dbQuery, {
    actor,
    userId: deleted.customer_id,
    action: "preference_deleted",
    result: "deleted",
    metadata: { preferenceId: deleted.id, preferenceType: deleted.preference_type, adminOverride },
  });
  return { ok: true, preference: publicPreference(deleted) };
}

async function deleteAllPreferences(dbQuery, { customerId, actor = "customer" } = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraPreferenceTables(dbQuery);
  const listed = await listCustomerPreferences(dbQuery, { customerId });
  let count = 0;
  for (const p of listed.preferences || []) {
    const out = await deletePreference(dbQuery, {
      preferenceId: p.preferenceId,
      customerId,
      actor,
      actorUserId: customerId,
    });
    if (out.ok) count += 1;
  }
  await logAuraAction(dbQuery, {
    actor,
    userId: customerId,
    action: "preference_delete_all",
    result: "deleted",
    metadata: { count },
  });
  return { ok: true, deleted: count };
}

async function withdrawConsent(dbQuery, { customerId, actor = "customer" } = {}) {
  const out = await deleteAllPreferences(dbQuery, { customerId, actor });
  if (!out.ok) return out;
  await ensureAuraPreferenceTables(dbQuery);
  await recordEvent(dbQuery, {
    customerId,
    eventType: "consent_withdrawn",
    actor,
    actorUserId: customerId,
  });
  await logAuraAction(dbQuery, {
    actor,
    userId: customerId,
    action: "preference_consent_withdrawn",
    result: "withdrawn",
    metadata: { deleted: out.deleted },
  });
  return { ok: true, consentStatus: "withdrawn", deleted: out.deleted };
}

/**
 * Suggestion text only — never books, charges, or contacts.
 * Each suggestion is optional and requires explicit confirmation before any availability search.
 */
async function buildPreferenceSuggestions(dbQuery, { customerId, force = false } = {}) {
  if (!suggestionsEnabled()) {
    return { ok: false, error: "aura_phase3_preference_suggestions_disabled", suggestions: [] };
  }
  if (!customerId) return { ok: false, error: "customer_required" };
  await ensureAuraPreferenceTables(dbQuery);
  const listed = await listCustomerPreferences(dbQuery, { customerId });
  if (!listed.ok) return listed;

  // Active granted preferences only (soft-deleted / withdrawn excluded by list).
  const prefs = (listed.preferences || []).filter((p) => p.consentStatus === "granted" && !p.deletedAt);
  const suggestions = [];
  const days = prefs.find((p) => p.preferenceType === "preferred_days");
  const times = prefs.find((p) => p.preferenceType === "preferred_time_ranges");
  const barber = prefs.find((p) => p.preferenceType === "preferred_barber");
  const services = prefs.find((p) => p.preferenceType === "preferred_services");
  const language = prefs.find((p) => p.preferenceType === "preferred_language");

  if (days?.preferenceValue?.days?.length) {
    const d = days.preferenceValue.days.join(", ");
    suggestions.push({
      id: `preferred_days:${d}`,
      type: "preferred_days",
      message: `You usually prefer ${d}. This is optional — would you like me to check those days?`,
      optional: true,
      requiresConfirmation: true,
      autoBook: false,
      criteria: { days: days.preferenceValue.days },
    });
  }
  if (times?.preferenceValue?.ranges?.length) {
    const r = times.preferenceValue.ranges[0];
    suggestions.push({
      id: `preferred_time_ranges:${r.start}-${r.end}`,
      type: "preferred_time_ranges",
      message: `You usually prefer ${r.start}–${r.end}. This is optional — would you like me to check those times?`,
      optional: true,
      requiresConfirmation: true,
      autoBook: false,
      criteria: { ranges: times.preferenceValue.ranges },
    });
  }
  if (barber?.preferenceValue) {
    const name = barber.preferenceValue.barberName || "your preferred barber";
    suggestions.push({
      id: `preferred_barber:${barber.preferenceValue.barberId || name}`,
      type: "preferred_barber",
      message: `You usually prefer ${name}. This is optional — would you like me to check their availability?`,
      optional: true,
      requiresConfirmation: true,
      autoBook: false,
      criteria: {
        barberId: barber.preferenceValue.barberId || null,
        barberName: barber.preferenceValue.barberName || null,
      },
    });
  }
  if (services?.preferenceValue?.services?.length) {
    const svc = services.preferenceValue.services.join(", ");
    suggestions.push({
      id: `preferred_services:${svc}`,
      type: "preferred_services",
      message: `You usually prefer ${svc}. This is optional — would you like me to check availability for that?`,
      optional: true,
      requiresConfirmation: true,
      autoBook: false,
      criteria: { services: services.preferenceValue.services },
    });
  }
  if (language?.preferenceValue?.language) {
    suggestions.push({
      id: `preferred_language:${language.preferenceValue.language}`,
      type: "preferred_language",
      message: `You usually prefer ${language.preferenceValue.language}. This is optional — would you like me to continue in that language?`,
      optional: true,
      requiresConfirmation: true,
      autoBook: false,
      criteria: { language: language.preferenceValue.language },
    });
  }

  // Deduplicate: skip re-logging identical suggestion sets within 10 minutes.
  const fingerprint = suggestions
    .map((s) => s.id)
    .sort()
    .join("|");
  let logged = [];
  if (suggestions.length && fingerprint) {
    const recent = await dbQuery(
      `SELECT metadata, created_at FROM aura_action_logs
       WHERE user_id = $1::uuid
         AND action = 'preference_suggestion'
         AND created_at > NOW() - INTERVAL '10 minutes'
       ORDER BY created_at DESC
       LIMIT 40`,
      [customerId],
    );
    const already = (recent.rows || []).some((r) => String(r.metadata?.fingerprint || "") === fingerprint);
    if (!force && already) {
      return {
        ok: true,
        suggestions,
        autoBook: false,
        optional: true,
        requiresConfirmation: true,
        deduped: true,
        guaranteedAvailability: false,
        overrides: preferencesCannotOverrideScheduling(),
      };
    }

    // Exactly one aura_action_logs row per suggestion offered.
    for (const s of suggestions) {
      await logAuraAction(dbQuery, {
        actor: "aura",
        userId: customerId,
        action: "preference_suggestion",
        result: "suggested",
        metadata: {
          suggestionId: s.id,
          type: s.type,
          message: s.message,
          optional: true,
          requiresConfirmation: true,
          autoBook: false,
          fingerprint,
          overrides: preferencesCannotOverrideScheduling(),
        },
      });
      logged.push(s.id);
    }
  } else {
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: customerId,
      action: "preference_suggestion",
      result: "none",
      metadata: { count: 0, fingerprint: "" },
    });
  }

  return {
    ok: true,
    suggestions,
    autoBook: false,
    optional: true,
    requiresConfirmation: true,
    deduped: false,
    guaranteedAvailability: false,
    loggedSuggestionIds: logged,
    overrides: preferencesCannotOverrideScheduling(),
  };
}

/**
 * Customer responds to a suggestion. Decline = no change.
 * Accept = begin availability search only (never books/charges/contacts).
 */
async function respondToPreferenceSuggestion(dbQuery, {
  customerId,
  suggestionId = null,
  suggestionType = null,
  decision,
  criteria = null,
} = {}) {
  if (!suggestionsEnabled()) {
    return { ok: false, error: "aura_phase3_preference_suggestions_disabled" };
  }
  if (!customerId) return { ok: false, error: "customer_required" };
  const dec = String(decision || "").trim().toLowerCase();
  if (dec !== "accept" && dec !== "decline") {
    return { ok: false, error: "decision_must_be_accept_or_decline" };
  }

  const listed = await listCustomerPreferences(dbQuery, { customerId });
  if (!listed.ok) return listed;
  const ownedTypes = new Set(
    (listed.preferences || [])
      .filter((p) => p.consentStatus === "granted" && !p.deletedAt)
      .map((p) => p.preferenceType),
  );
  if (suggestionType && !ownedTypes.has(suggestionType) && dec === "accept") {
    return {
      ok: false,
      error: "preference_not_active",
      message: "That preference is not active for your account (deleted or withdrawn preferences are not used).",
    };
  }

  if (dec === "decline") {
    await logAuraAction(dbQuery, {
      actor: "customer",
      userId: customerId,
      action: "preference_suggestion_declined",
      result: "declined",
      metadata: { suggestionId, suggestionType, changed: false, autoBook: false },
    });
    return {
      ok: true,
      decision: "decline",
      changed: false,
      beginAvailabilitySearch: false,
      autoBook: false,
      message: "Okay — I won’t use that suggestion.",
    };
  }

  const searchCriteria = criteria || {};
  await logAuraAction(dbQuery, {
    actor: "customer",
    userId: customerId,
    action: "preference_suggestion_accepted",
    result: "availability_search_only",
    metadata: {
      suggestionId,
      suggestionType,
      searchCriteria,
      beginAvailabilitySearch: true,
      autoBook: false,
      appointmentCreated: false,
      paymentTriggered: false,
      contactTriggered: false,
      guaranteedAvailability: false,
    },
  });

  return {
    ok: true,
    decision: "accept",
    beginAvailabilitySearch: true,
    autoBook: false,
    appointmentCreated: false,
    paymentTriggered: false,
    cancellationTriggered: false,
    rescheduleTriggered: false,
    contactTriggered: false,
    guaranteedAvailability: false,
    searchCriteria,
    message:
      "I’ll check availability based on your preference. Times are not guaranteed until a slot is confirmed available and you approve a booking.",
    overrides: preferencesCannotOverrideScheduling(),
  };
}

/**
 * Explicit guard used by booking paths — preferences never force a slot.
 */
function assertPreferenceDoesNotOverride({ slotAvailable = false } = {}) {
  const base = preferencesCannotOverrideScheduling();
  if (!slotAvailable) {
    return {
      ok: false,
      blocked: true,
      reason: "preference_cannot_override_availability",
      overrideAllowed: false,
      autoBook: false,
      autoBookAllowed: false,
      message:
        "That time is not available. Your saved preference cannot override the schedule.",
    };
  }
  return {
    ok: true,
    blocked: false,
    autoBook: false,
    overrideAllowed: false,
    autoBookAllowed: false,
    ...base,
  };
}

/** Admin may review preferences for a customer; may not fabricate hidden profiles. */
async function adminListPreferences(dbQuery, { customerId } = {}) {
  if (!prefsEnabled()) return { ok: false, error: "aura_phase3_preferences_disabled" };
  if (!customerId) return { ok: false, error: "customer_required" };
  return listCustomerPreferences(dbQuery, { customerId, includeDeleted: true });
}

module.exports = {
  prefsEnabled,
  suggestionsEnabled,
  offerPreferenceConsent,
  declinePreferenceConsent,
  listCustomerPreferences,
  getPreferenceForCustomer,
  savePreferenceWithConsent,
  deletePreference,
  deleteAllPreferences,
  withdrawConsent,
  buildPreferenceSuggestions,
  respondToPreferenceSuggestion,
  assertPreferenceDoesNotOverride,
  adminListPreferences,
  buildConsentPrompt,
  publicPreference,
};
