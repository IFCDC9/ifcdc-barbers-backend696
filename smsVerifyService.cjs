/**
 * Twilio Verify — AURA Super Admin SMS codes + customer phone verification.
 * Rate limits, expiration (Twilio-managed), retry caps. Never queues OTP in pending_email_deliveries.
 */
const {
  getTwilioClient,
  getTwilioVerifyServiceSid,
  isTwilioVerifyConfigured,
} = require("./smsTwilioClient.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");
const { isSmsVerifyEnabled } = require("./smsFlags.cjs");
const {
  ensureSmsVerifyRateLimitTable,
  ensureAppUserPhoneVerificationColumns,
} = require("./smsMigrations.cjs");

const MAX_SENDS_PER_HOUR = Number(process.env.SMS_VERIFY_MAX_SENDS_PER_HOUR || 8);
const MAX_CHECKS_PER_HOUR = Number(process.env.SMS_VERIFY_MAX_CHECKS_PER_HOUR || 30);
const MIN_SECONDS_BETWEEN_SENDS = Number(process.env.SMS_VERIFY_MIN_SECONDS_BETWEEN_SENDS || 25);
const SUPER_ADMIN_MAX_SENDS_PER_HOUR = Number(process.env.SMS_VERIFY_SA_MAX_SENDS_PER_HOUR || 15);
const SUPER_ADMIN_MAX_CHECKS_PER_HOUR = Number(process.env.SMS_VERIFY_SA_MAX_CHECKS_PER_HOUR || 40);
const SUPER_ADMIN_MIN_SECONDS_BETWEEN_SENDS = Number(
  process.env.SMS_VERIFY_SA_MIN_SECONDS_BETWEEN_SENDS || 20,
);
const RATE_LIMIT_USER_MESSAGE = "Please wait a moment and try again.";

function limitsForPurpose(purpose) {
  const p = String(purpose || "");
  if (p === "super_admin_login") {
    return {
      maxSends: SUPER_ADMIN_MAX_SENDS_PER_HOUR,
      maxChecks: SUPER_ADMIN_MAX_CHECKS_PER_HOUR,
      minSecondsBetweenSends: SUPER_ADMIN_MIN_SECONDS_BETWEEN_SENDS,
    };
  }
  return {
    maxSends: MAX_SENDS_PER_HOUR,
    maxChecks: MAX_CHECKS_PER_HOUR,
    minSecondsBetweenSends: MIN_SECONDS_BETWEEN_SENDS,
  };
}

async function recordAttempt(dbQuery, row) {
  if (typeof dbQuery !== "function") return;
  await ensureSmsVerifyRateLimitTable(dbQuery);
  await dbQuery(
    `INSERT INTO sms_verify_attempts (phone_e164, purpose, actor_user_id, ip_text, action, result, metadata)
     VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::jsonb)`,
    [
      row.phoneE164,
      row.purpose,
      row.actorUserId || null,
      row.ipText || null,
      row.action,
      row.result || null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
}

/** Only count real Twilio traffic — never rate_limited / retry_too_soon (those used to lock users out permanently). */
async function countRecent(dbQuery, { phoneE164, purpose, action, sinceMinutes, results = null }) {
  const params = [phoneE164, purpose, action, String(sinceMinutes)];
  let resultClause = "";
  if (Array.isArray(results) && results.length > 0) {
    resultClause = ` AND result = ANY($${params.length + 1}::text[])`;
    params.push(results);
  }
  const r = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM sms_verify_attempts
     WHERE phone_e164 = $1 AND purpose = $2 AND action = $3
       AND created_at > NOW() - ($4::text || ' minutes')::interval
       ${resultClause}`,
    params,
  );
  return Number(r.rows?.[0]?.n || 0);
}

async function secondsSinceLastSuccessfulSend(dbQuery, { phoneE164, purpose }) {
  const r = await dbQuery(
    `SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::int AS secs
     FROM sms_verify_attempts
     WHERE phone_e164 = $1 AND purpose = $2 AND action = 'send' AND result = 'sent'
     ORDER BY created_at DESC LIMIT 1`,
    [phoneE164, purpose],
  );
  const secs = r.rows?.[0]?.secs;
  return secs == null ? null : Number(secs);
}

async function hasRecentSuccessfulSend(dbQuery, { phoneE164, purpose, withinMinutes = 10 }) {
  const n = await countRecent(dbQuery, {
    phoneE164,
    purpose,
    action: "send",
    sinceMinutes: withinMinutes,
    results: ["sent"],
  });
  return n > 0;
}

async function assertSendAllowed(dbQuery, { phoneE164, purpose }) {
  await ensureSmsVerifyRateLimitTable(dbQuery);
  const limits = limitsForPurpose(purpose);
  const sends = await countRecent(dbQuery, {
    phoneE164,
    purpose,
    action: "send",
    sinceMinutes: 60,
    results: ["sent"],
  });
  if (sends >= limits.maxSends) {
    const alreadySent = await hasRecentSuccessfulSend(dbQuery, { phoneE164, purpose, withinMinutes: 15 });
    return {
      ok: false,
      error: "rate_limited",
      message: RATE_LIMIT_USER_MESSAGE,
      alreadySent,
    };
  }
  const since = await secondsSinceLastSuccessfulSend(dbQuery, { phoneE164, purpose });
  if (since != null && since < limits.minSecondsBetweenSends) {
    const alreadySent = since < 600;
    return {
      ok: false,
      error: "retry_too_soon",
      message: RATE_LIMIT_USER_MESSAGE,
      retryAfterSec: limits.minSecondsBetweenSends - since,
      alreadySent,
    };
  }
  return { ok: true };
}

async function assertCheckAllowed(dbQuery, { phoneE164, purpose }) {
  const limits = limitsForPurpose(purpose);
  const checks = await countRecent(dbQuery, {
    phoneE164,
    purpose,
    action: "check",
    sinceMinutes: 60,
    results: ["approved", "denied", "failed"],
  });
  if (checks >= limits.maxChecks) {
    return { ok: false, error: "rate_limited", message: RATE_LIMIT_USER_MESSAGE };
  }
  return { ok: true };
}

async function resolveVerifyServiceSid() {
  const {
    getTwilioClient,
    getTwilioVerifyServiceSid,
    isTwilioAccountConfigured,
  } = require("./smsTwilioClient.cjs");
  let sid = getTwilioVerifyServiceSid();
  if (sid && /^VA[0-9a-fA-F]{32}$/.test(sid)) return sid;
  if (!isTwilioAccountConfigured()) return "";
  try {
    const client = getTwilioClient();
    const services = await client.verify.v2.services.list({ limit: 10 });
    const match =
      services.find((s) => /AURA|IFCDC|Verification|Verify/i.test(String(s.friendlyName || ""))) ||
      services[0];
    if (match?.sid && /^VA[0-9a-fA-F]{32}$/.test(match.sid)) {
      process.env.TWILIO_VERIFY_SERVICE_SID = match.sid;
      console.log("[sms-verify] resolved TWILIO_VERIFY_SERVICE_SID prefix:", `${match.sid.slice(0, 4)}…`);
      return match.sid;
    }
  } catch (e) {
    console.warn("[sms-verify] Verify SID resolve failed:", e?.message || e);
  }
  return getTwilioVerifyServiceSid() || "";
}

/**
 * Start Twilio Verify SMS.
 * purpose: "super_admin_login" | "customer_phone"
 */
async function startSmsVerification(
  dbQuery,
  { phone, purpose, actorUserId = null, ipText = null } = {},
) {
  if (!isSmsVerifyEnabled()) {
    return { ok: false, error: "sms_verify_disabled", message: "SMS verification is not enabled." };
  }
  const resolvedSid = await resolveVerifyServiceSid();
  if (!resolvedSid && !isTwilioVerifyConfigured()) {
    return {
      ok: false,
      error: "twilio_verify_not_configured",
      message: "TWILIO_VERIFY_SERVICE_SID is not configured.",
    };
  }
  const phoneNorm = normalizeToE164(phone);
  if (!phoneNorm.ok) return { ok: false, error: phoneNorm.error, message: phoneNorm.message };

  const allowed = await assertSendAllowed(dbQuery, {
    phoneE164: phoneNorm.e164,
    purpose: String(purpose || "customer_phone"),
  });
  if (!allowed.ok) {
    // Do not record as action=send — that used to inflate the hourly cap permanently.
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "send_blocked",
      result: allowed.error,
      metadata: { alreadySent: Boolean(allowed.alreadySent) },
    });
    return allowed;
  }

  // Customer verification SMS requires transactional consent. Super-admin login is exempt.
  const purposeKey = String(purpose || "customer_phone");
  if (purposeKey === "customer_phone" && typeof dbQuery === "function") {
    try {
      const { ensureSmsConsentTable } = require("./smsMigrations.cjs");
      await ensureSmsConsentTable(dbQuery);
      const consent = await dbQuery(
        `SELECT transactional_opt_in, opted_out_at FROM sms_consent
         WHERE phone_e164 = $1 LIMIT 1`,
        [phoneNorm.e164],
      );
      const c = consent.rows?.[0];
      if (!c || c.transactional_opt_in !== true || c.opted_out_at) {
        await recordAttempt(dbQuery, {
          phoneE164: phoneNorm.e164,
          purpose: purposeKey,
          actorUserId,
          ipText,
          action: "send_blocked",
          result: c ? "opted_out" : "no_sms_consent",
        });
        return {
          ok: false,
          error: c ? "opted_out" : "no_sms_consent",
          message:
            "SMS consent is required before sending a verification code. Opt in at /sms-consent or reply START.",
        };
      }
    } catch (e) {
      console.warn("[sms-verify] consent check failed:", e?.message || e);
      return {
        ok: false,
        error: "consent_check_failed",
        message: "Could not verify SMS consent. Try again shortly.",
      };
    }
  }

  try {
    const verifySid = await resolveVerifyServiceSid();
    if (!verifySid) {
      return {
        ok: false,
        error: "twilio_verify_not_configured",
        message: "TWILIO_VERIFY_SERVICE_SID is not configured.",
      };
    }
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(verifySid)
      .verifications.create({ to: phoneNorm.e164, channel: "sms" });

    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "send",
      result: "sent",
      metadata: {
        status: verification.status,
        sid: verification.sid,
        channel: "sms",
        masked: maskPhoneForDisplay(phoneNorm.e164),
      },
    });

    console.log("[sms-verify] start OK", {
      purpose: String(purpose || "customer_phone"),
      channel: "sms",
      toMasked: maskPhoneForDisplay(phoneNorm.e164),
      twilioSid: verification.sid || null,
      status: verification.status || null,
    });

    return {
      ok: true,
      toMasked: maskPhoneForDisplay(phoneNorm.e164),
      status: verification.status,
      sid: verification.sid || null,
      twilioSid: verification.sid || null,
      channel: "sms",
      // Twilio Verify manages TTL (typically 10 minutes) — do not store plaintext codes.
    };
  } catch (e) {
    const err = e?.message || String(e);
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "send",
      result: "failed",
      metadata: { error: err },
    });
    console.error("[sms-verify] start failed", {
      purpose: String(purpose || "customer_phone"),
      channel: "sms",
      toMasked: maskPhoneForDisplay(phoneNorm.e164),
      error: err,
      errorCode: e?.code || e?.status || null,
    });
    return { ok: false, error: "verify_send_failed", message: "Could not send verification SMS." };
  }
}

async function checkSmsVerification(
  dbQuery,
  { phone, code, purpose, actorUserId = null, ipText = null, markUserVerified = false } = {},
) {
  if (!isSmsVerifyEnabled()) {
    return { ok: false, error: "sms_verify_disabled", message: "SMS verification is not enabled." };
  }
  const resolvedSid = await resolveVerifyServiceSid();
  if (!resolvedSid && !isTwilioVerifyConfigured()) {
    return { ok: false, error: "twilio_verify_not_configured", message: "Verify service not configured." };
  }
  const phoneNorm = normalizeToE164(phone);
  if (!phoneNorm.ok) return { ok: false, error: phoneNorm.error, message: phoneNorm.message };
  const rawCode = String(code || "").trim().replace(/\s+/g, "");
  if (!/^\d{4,10}$/.test(rawCode)) {
    return { ok: false, error: "invalid_code", message: "Enter the verification code from your text." };
  }

  const allowed = await assertCheckAllowed(dbQuery, {
    phoneE164: phoneNorm.e164,
    purpose: String(purpose || "customer_phone"),
  });
  if (!allowed.ok) {
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "check_blocked",
      result: allowed.error,
    });
    return allowed;
  }

  try {
    const verifySid = await resolveVerifyServiceSid();
    if (!verifySid) {
      return {
        ok: false,
        error: "twilio_verify_not_configured",
        message: "Could not validate verification code. Please try again.",
      };
    }
    const client = getTwilioClient();
    const check = await client.verify.v2
      .services(verifySid)
      .verificationChecks.create({ to: phoneNorm.e164, code: rawCode });

    const approved = String(check.status || "").toLowerCase() === "approved";
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "check",
      result: approved ? "approved" : "denied",
      metadata: { status: check.status },
    });

    if (!approved) {
      return { ok: false, error: "invalid_code", message: "Invalid or expired verification code." };
    }

    if (markUserVerified && actorUserId) {
      await ensureAppUserPhoneVerificationColumns(dbQuery);
      await dbQuery(
        `UPDATE app_users
         SET phone_e164 = $2,
             phone = COALESCE(phone, $2),
             phone_verified = true,
             phone_verified_at = NOW()
         WHERE id = $1::uuid`,
        [actorUserId, phoneNorm.e164],
      );
    }

    return { ok: true, e164: phoneNorm.e164, status: "approved" };
  } catch (e) {
    const err = e?.message || String(e);
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "check",
      result: "failed",
      metadata: { error: err },
    });
    console.warn("[sms-verify] check failed:", err);
    const notFound = /not found|20404/i.test(err);
    return {
      ok: false,
      error: notFound ? "code_expired" : "verify_check_failed",
      message: notFound
        ? "That verification code expired. Sign in again to receive a new SMS code."
        : "Could not validate verification code. Please try again.",
    };
  }
}

module.exports = {
  startSmsVerification,
  checkSmsVerification,
  resolveVerifyServiceSid,
  hasRecentSuccessfulSend,
  RATE_LIMIT_USER_MESSAGE,
  MAX_SENDS_PER_HOUR,
  MAX_CHECKS_PER_HOUR,
  MIN_SECONDS_BETWEEN_SENDS,
};
