/**
 * Founder audit + last-briefing state. Never stores PIN values.
 */
const { ensureAuraFounderSchema } = require("./auraFounderMigrations.cjs");
const { maskPhonePartial } = require("./auraFounderIdentity.cjs");

async function recordFounderActivity(dbQuery, { callSid, fromE164, eventKind, ok, detail } = {}) {
  if (typeof dbQuery !== "function" || !eventKind) return null;
  try {
    await ensureAuraFounderSchema(dbQuery);
    const safeDetail = detail && typeof detail === "object" ? { ...detail } : {};
    delete safeDetail.pin;
    delete safeDetail.ownerPin;
    delete safeDetail.founderPin;
    delete safeDetail.rawPin;
    const ins = await dbQuery(
      `INSERT INTO aura_founder_activity (call_sid, from_e164, event_kind, ok, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING id`,
      [
        callSid || null,
        fromE164 || null,
        String(eventKind).slice(0, 120),
        ok == null ? null : Boolean(ok),
        JSON.stringify(safeDetail),
      ],
    );
    return ins.rows?.[0]?.id || null;
  } catch (e) {
    console.warn("[aura-founder] activity:", e?.message || e);
    return null;
  }
}

async function getFounderState(dbQuery) {
  if (typeof dbQuery !== "function") return null;
  try {
    await ensureAuraFounderSchema(dbQuery);
    const r = await dbQuery(`SELECT * FROM aura_founder_state WHERE id = 1 LIMIT 1`);
    return r.rows?.[0] || null;
  } catch (e) {
    console.warn("[aura-founder] getState:", e?.message || e);
    return null;
  }
}

async function markFounderBriefingDelivered(dbQuery, { callSid, fromE164 } = {}) {
  if (typeof dbQuery !== "function") return false;
  try {
    await ensureAuraFounderSchema(dbQuery);
    await dbQuery(
      `UPDATE aura_founder_state SET
         last_briefing_at = NOW(),
         last_call_sid = COALESCE($1, last_call_sid),
         last_founder_from_e164 = COALESCE($2, last_founder_from_e164),
         updated_at = NOW()
       WHERE id = 1`,
      [callSid || null, fromE164 || null],
    );
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "founder_briefing_delivered",
      ok: true,
      detail: {},
    });
    return true;
  } catch (e) {
    console.warn("[aura-founder] markBriefing:", e?.message || e);
    return false;
  }
}

function sanitizeFounderEventPayload(payload) {
  const p = payload && typeof payload === "object" ? { ...payload } : {};
  delete p.pin;
  delete p.ownerPin;
  delete p.founderPin;
  if (p.customerPhone) {
    p.customerPhoneMasked = maskPhonePartial(p.customerPhone);
    delete p.customerPhone;
  }
  return p;
}

module.exports = {
  recordFounderActivity,
  getFounderState,
  markFounderBriefingDelivered,
  sanitizeFounderEventPayload,
};
