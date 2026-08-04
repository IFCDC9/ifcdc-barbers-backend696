/**
 * SMS consent — transactional opt-in/out. STOP / HELP keywords.
 * No promotional messaging in this system.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const { ensureSmsConsentTable } = require("./smsMigrations.cjs");
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");

async function upsertConsent(
  dbQuery,
  { phone, userId = null, optIn = true, keyword = null, source = "api" } = {},
) {
  const phoneNorm = normalizeToE164(phone);
  if (!phoneNorm.ok) return { ok: false, error: phoneNorm.error };
  await ensureSmsConsentTable(dbQuery);
  const optedOut = !optIn;
  const r = await dbQuery(
    `INSERT INTO sms_consent
       (user_id, phone_e164, transactional_opt_in, opted_out_at, opted_in_at, last_inbound_keyword, source)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7)
     ON CONFLICT (phone_e164) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, sms_consent.user_id),
       transactional_opt_in = EXCLUDED.transactional_opt_in,
       opted_out_at = EXCLUDED.opted_out_at,
       opted_in_at = EXCLUDED.opted_in_at,
       last_inbound_keyword = EXCLUDED.last_inbound_keyword,
       source = EXCLUDED.source,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      phoneNorm.e164,
      Boolean(optIn),
      optedOut ? new Date().toISOString() : null,
      optIn ? new Date().toISOString() : null,
      keyword,
      source,
    ],
  );
  return { ok: true, consent: r.rows?.[0] || null };
}

async function handleInboundSmsKeyword(dbQuery, { from, body, publicBaseUrl } = {}) {
  const phoneNorm = normalizeToE164(from);
  if (!phoneNorm.ok) return { ok: false, error: "invalid_from" };
  const text = String(body || "").trim().toUpperCase();
  const word = text.split(/\s+/)[0] || "";

  if (word === "STOP" || word === "STOPALL" || word === "UNSUBSCRIBE" || word === "CANCEL" || word === "END" || word === "QUIT") {
    await upsertConsent(dbQuery, {
      phone: phoneNorm.e164,
      optIn: false,
      keyword: word,
      source: "inbound_stop",
    });
    // Twilio often auto-replies for Advanced Opt-Out; we still log consent.
    return { ok: true, action: "opt_out", keyword: word };
  }

  if (word === "START" || word === "UNSTOP" || word === "YES") {
    await upsertConsent(dbQuery, {
      phone: phoneNorm.e164,
      optIn: true,
      keyword: word,
      source: "inbound_start",
    });
    return { ok: true, action: "opt_in", keyword: word };
  }

  if (word === "HELP" || word === "INFO") {
    const helpBody =
      "IFCDC Barbers: transactional SMS for bookings, payments, and account security only. Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out. Support: service@ifcdc.org";
    await sendTransactionalSms(dbQuery, {
      to: phoneNorm.e164,
      body: helpBody,
      category: "consent_help",
      idempotencyKey: `help:${phoneNorm.e164}:${new Date().toISOString().slice(0, 13)}`,
      force: true,
      statusCallbackUrl: publicBaseUrl
        ? `${String(publicBaseUrl).replace(/\/$/, "")}/api/sms/status`
        : null,
    });
    await upsertConsent(dbQuery, {
      phone: phoneNorm.e164,
      optIn: true,
      keyword: word,
      source: "inbound_help",
    });
    return { ok: true, action: "help", keyword: word };
  }

  return { ok: true, action: "ignored", keyword: word || null };
}

module.exports = {
  upsertConsent,
  handleInboundSmsKeyword,
};
