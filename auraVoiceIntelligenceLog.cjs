/**
 * Call logging + caller memory for Voice Intelligence Phase 1.
 */
const { auraVoiceIntelligenceFlags } = require("./auraVoiceIntelligenceFlags.cjs");
const { ensureAuraVoiceIntelligenceSchema } = require("./auraVoiceIntelligenceMigrations.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");

const turnCounters = new Map();

function nextTurn(callSid) {
  const k = String(callSid || "").trim() || "_";
  const n = (turnCounters.get(k) || 0) + 1;
  turnCounters.set(k, n);
  if (turnCounters.size > 3000) {
    const first = turnCounters.keys().next().value;
    turnCounters.delete(first);
  }
  return n;
}

async function upsertCall(dbQuery, row) {
  if (typeof dbQuery !== "function") return null;
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const callSid = String(row.callSid || "").trim() || null;
  if (!callSid) return null;
  const existing = await dbQuery(
    `SELECT id FROM aura_voice_calls WHERE call_sid = $1 LIMIT 1`,
    [callSid],
  );
  if (existing.rows?.[0]?.id) {
    await dbQuery(
      `UPDATE aura_voice_calls SET
         updated_at = NOW(),
         from_e164 = COALESCE($2, from_e164),
         to_e164 = COALESCE($3, to_e164),
         verified_status = COALESCE($4, verified_status),
         is_owner = COALESCE($5, is_owner),
         primary_intent = COALESCE($6, primary_intent),
         intents = COALESCE($7::jsonb, intents),
         metadata = COALESCE($8::jsonb, metadata)
       WHERE call_sid = $1`,
      [
        callSid,
        row.fromE164 || null,
        row.toE164 || null,
        row.verifiedStatus || null,
        row.isOwner == null ? null : Boolean(row.isOwner),
        row.primaryIntent || null,
        row.intents ? JSON.stringify(row.intents) : null,
        row.metadata ? JSON.stringify(row.metadata) : null,
      ],
    );
    return existing.rows[0].id;
  }
  const ins = await dbQuery(
    `INSERT INTO aura_voice_calls
       (call_sid, from_e164, to_e164, verified_status, is_owner, primary_intent, intents, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
     RETURNING id`,
    [
      callSid,
      row.fromE164 || null,
      row.toE164 || null,
      row.verifiedStatus || "unverified",
      Boolean(row.isOwner),
      row.primaryIntent || null,
      row.intents ? JSON.stringify(row.intents) : null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
  return ins.rows?.[0]?.id || null;
}

async function appendTurn(dbQuery, turn) {
  if (typeof dbQuery !== "function") return;
  if (!auraVoiceIntelligenceFlags().callLogging) return;
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const callId = turn.callId || null;
  const callSid = String(turn.callSid || "").trim() || null;
  const idx = turn.turnIndex != null ? turn.turnIndex : nextTurn(callSid);
  await dbQuery(
    `INSERT INTO aura_voice_call_turns
       (call_id, call_sid, turn_index, role, intent, user_text, assistant_text, action, action_ok, metadata)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      callId,
      callSid,
      idx,
      turn.role || "user",
      turn.intent || null,
      turn.userText ? String(turn.userText).slice(0, 2000) : null,
      turn.assistantText ? String(turn.assistantText).slice(0, 2000) : null,
      turn.action || null,
      turn.actionOk == null ? null : Boolean(turn.actionOk),
      turn.metadata ? JSON.stringify(turn.metadata) : null,
    ],
  );
}

async function finalizeCall(dbQuery, { callSid, outcome, summary, escalationStatus } = {}) {
  if (typeof dbQuery !== "function" || !callSid) return;
  await dbQuery(
    `UPDATE aura_voice_calls SET
       updated_at = NOW(),
       ended_at = NOW(),
       duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int),
       outcome = COALESCE($2, outcome),
       conversation_summary = COALESCE($3, conversation_summary),
       escalation_status = COALESCE($4, escalation_status)
     WHERE call_sid = $1`,
    [callSid, outcome || null, summary ? String(summary).slice(0, 2000) : null, escalationStatus || null],
  );
}

async function recordAction(dbQuery, { callSid, kind, payload, ok }) {
  if (typeof dbQuery !== "function" || !callSid) return;
  const col = ok ? "actions_completed" : "actions_failed";
  await dbQuery(
    `UPDATE aura_voice_calls SET
       updated_at = NOW(),
       ${col} = coalesce(${col}, '[]'::jsonb) || $2::jsonb
     WHERE call_sid = $1`,
    [callSid, JSON.stringify([{ kind, at: new Date().toISOString(), ...(payload || {}) }])],
  );
}

async function getCallerProfile(dbQuery, phoneRaw) {
  if (!auraVoiceIntelligenceFlags().callerMemory || typeof dbQuery !== "function") return null;
  const n = normalizeToE164(phoneRaw);
  if (!n.ok) return null;
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const r = await dbQuery(
    `SELECT * FROM aura_voice_caller_profiles WHERE phone_e164 = $1 LIMIT 1`,
    [n.e164],
  );
  return r.rows?.[0] || null;
}

async function touchCallerProfile(dbQuery, phoneRaw, patch = {}) {
  if (!auraVoiceIntelligenceFlags().callerMemory || typeof dbQuery !== "function") return null;
  const n = normalizeToE164(phoneRaw);
  if (!n.ok) return null;
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  await dbQuery(
    `INSERT INTO aura_voice_caller_profiles (phone_e164, display_name, preferred_barber, language_pref, call_count)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (phone_e164) DO UPDATE SET
       updated_at = NOW(),
       display_name = COALESCE($2, aura_voice_caller_profiles.display_name),
       preferred_barber = COALESCE($3, aura_voice_caller_profiles.preferred_barber),
       language_pref = COALESCE($4, aura_voice_caller_profiles.language_pref),
       call_count = aura_voice_caller_profiles.call_count + 1,
       unfinished_session = COALESCE($5::jsonb, aura_voice_caller_profiles.unfinished_session)`,
    [
      n.e164,
      patch.displayName || null,
      patch.preferredBarber || null,
      patch.languagePref || null,
      patch.unfinishedSession ? JSON.stringify(patch.unfinishedSession) : null,
    ],
  );
  return getCallerProfile(dbQuery, n.e164);
}

async function createEscalation(dbQuery, row) {
  if (typeof dbQuery !== "function") return null;
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const ins = await dbQuery(
    `INSERT INTO aura_voice_escalations
       (call_id, call_sid, from_e164, caller_name, reason, appointment_ref, actions_attempted, recommended_next, metadata)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
     RETURNING id`,
    [
      row.callId || null,
      row.callSid || null,
      row.fromE164 || null,
      row.callerName || null,
      String(row.reason || "escalation").slice(0, 240),
      row.appointmentRef || null,
      row.actionsAttempted ? JSON.stringify(row.actionsAttempted) : null,
      row.recommendedNext || null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
  if (row.callSid) {
    await dbQuery(
      `UPDATE aura_voice_calls SET escalation_status = 'open', escalation_summary = $2, updated_at = NOW()
       WHERE call_sid = $1`,
      [row.callSid, String(row.reason || "").slice(0, 500)],
    );
  }
  try {
    const { emitFounderEvent } = require("./auraFounderNotify.cjs");
    void emitFounderEvent(dbQuery, {
      eventType: "customer_escalation",
      customerName: row.callerName || null,
      customerPhone: row.fromE164 || null,
      actionRequired: true,
      source: "aura_voice_escalation",
      payload: { reason: row.reason, appointmentRef: row.appointmentRef || null },
    });
  } catch {
    /* non-fatal */
  }
  return ins.rows?.[0]?.id || null;
}

async function adminListCalls(dbQuery, { limit = 50 } = {}) {
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const r = await dbQuery(
    `SELECT id, created_at, started_at, ended_at, duration_sec, call_sid, from_e164, verified_status,
            is_owner, primary_intent, outcome, escalation_status, conversation_summary
     FROM aura_voice_calls
     ORDER BY started_at DESC
     LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return (r.rows || []).map((row) => ({
    ...row,
    from_e164: row.from_e164 ? maskPhoneForDisplay(row.from_e164) : null,
  }));
}

async function adminCallStats(dbQuery) {
  await ensureAuraVoiceIntelligenceSchema(dbQuery);
  const r = await dbQuery(
    `SELECT
       COUNT(*)::int AS total_calls,
       COUNT(*) FILTER (WHERE escalation_status IS DISTINCT FROM 'none')::int AS escalations,
       COUNT(*) FILTER (WHERE outcome = 'completed' OR outcome = 'booking_created')::int AS completed,
       COALESCE(AVG(duration_sec) FILTER (WHERE duration_sec IS NOT NULL), 0)::int AS avg_duration_sec,
       COUNT(*) FILTER (WHERE primary_intent IS NOT NULL)::int AS with_intent
     FROM aura_voice_calls
     WHERE started_at > NOW() - INTERVAL '30 days'`,
  );
  const intents = await dbQuery(
    `SELECT primary_intent AS intent, COUNT(*)::int AS n
     FROM aura_voice_calls
     WHERE started_at > NOW() - INTERVAL '30 days' AND primary_intent IS NOT NULL
     GROUP BY primary_intent
     ORDER BY n DESC
     LIMIT 12`,
  );
  const row = r.rows?.[0] || {};
  const total = Number(row.total_calls || 0);
  const completed = Number(row.completed || 0);
  return {
    totalCalls30d: total,
    escalations30d: Number(row.escalations || 0),
    completed30d: completed,
    avgDurationSec: Number(row.avg_duration_sec || 0),
    successRate: total ? Math.round((completed / total) * 1000) / 10 : 0,
    topIntents: intents.rows || [],
  };
}

module.exports = {
  upsertCall,
  appendTurn,
  finalizeCall,
  recordAction,
  getCallerProfile,
  touchCallerProfile,
  createEscalation,
  adminListCalls,
  adminCallStats,
};
