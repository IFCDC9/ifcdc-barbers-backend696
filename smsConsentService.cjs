/**
 * SMS consent — transactional opt-in/out. STOP / HELP keywords.
 * No promotional messaging in this system.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const { ensureSmsConsentTable } = require("./smsMigrations.cjs");
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
const {
  SMS_CONSENT_LANGUAGE_VERSION,
  SMS_CONSENT_DISCLOSURE,
} = require("./smsConsentPublic.cjs");

async function upsertConsent(
  dbQuery,
  {
    phone,
    userId = null,
    optIn = false,
    keyword = null,
    source = "api",
    consentLanguageVersion = SMS_CONSENT_LANGUAGE_VERSION,
    metadata = null,
  } = {},
) {
  const phoneNorm = normalizeToE164(phone);
  if (!phoneNorm.ok) return { ok: false, error: phoneNorm.error };
  await ensureSmsConsentTable(dbQuery);
  const optedOut = !optIn;
  const meta = {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
    disclosure: SMS_CONSENT_DISCLOSURE,
  };
  const r = await dbQuery(
    `INSERT INTO sms_consent
       (user_id, phone_e164, transactional_opt_in, opted_out_at, opted_in_at,
        last_inbound_keyword, source, consent_language_version, metadata)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9::jsonb)
     ON CONFLICT (phone_e164) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, sms_consent.user_id),
       transactional_opt_in = EXCLUDED.transactional_opt_in,
       opted_out_at = EXCLUDED.opted_out_at,
       opted_in_at = EXCLUDED.opted_in_at,
       last_inbound_keyword = EXCLUDED.last_inbound_keyword,
       source = EXCLUDED.source,
       consent_language_version = EXCLUDED.consent_language_version,
       metadata = COALESCE(EXCLUDED.metadata, sms_consent.metadata),
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
      String(consentLanguageVersion || SMS_CONSENT_LANGUAGE_VERSION).slice(0, 80),
      JSON.stringify(meta),
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
      "IFCDC Barbers App (IFCDC): customer-care & appointment texts. Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out. Support: service@ifcdc.org";
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
    return { ok: true, action: "help", keyword: word };
  }

  return { ok: true, action: "ignored", keyword: word || null };
}

module.exports = {
  upsertConsent,
  handleInboundSmsKeyword,
  SMS_CONSENT_LANGUAGE_VERSION,
};
