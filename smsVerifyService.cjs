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

const MAX_SENDS_PER_HOUR = Number(process.env.SMS_VERIFY_MAX_SENDS_PER_HOUR || 5);
const MAX_CHECKS_PER_HOUR = Number(process.env.SMS_VERIFY_MAX_CHECKS_PER_HOUR || 10);
const MIN_SECONDS_BETWEEN_SENDS = Number(process.env.SMS_VERIFY_MIN_SECONDS_BETWEEN_SENDS || 45);

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

async function countRecent(dbQuery, { phoneE164, purpose, action, sinceMinutes }) {
  const r = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM sms_verify_attempts
     WHERE phone_e164 = $1 AND purpose = $2 AND action = $3
       AND created_at > NOW() - ($4::text || ' minutes')::interval`,
    [phoneE164, purpose, action, String(sinceMinutes)],
  );
  return Number(r.rows?.[0]?.n || 0);
}

async function secondsSinceLastSend(dbQuery, { phoneE164, purpose }) {
  const r = await dbQuery(
    `SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::int AS secs
     FROM sms_verify_attempts
     WHERE phone_e164 = $1 AND purpose = $2 AND action = 'send'
     ORDER BY created_at DESC LIMIT 1`,
    [phoneE164, purpose],
  );
  const secs = r.rows?.[0]?.secs;
  return secs == null ? null : Number(secs);
}

async function assertSendAllowed(dbQuery, { phoneE164, purpose }) {
  await ensureSmsVerifyRateLimitTable(dbQuery);
  const sends = await countRecent(dbQuery, {
    phoneE164,
    purpose,
    action: "send",
    sinceMinutes: 60,
  });
  if (sends >= MAX_SENDS_PER_HOUR) {
    return { ok: false, error: "rate_limited", message: "Too many code requests. Try again later." };
  }
  const since = await secondsSinceLastSend(dbQuery, { phoneE164, purpose });
  if (since != null && since < MIN_SECONDS_BETWEEN_SENDS) {
    return {
      ok: false,
      error: "retry_too_soon",
      message: `Wait ${MIN_SECONDS_BETWEEN_SENDS - since}s before requesting another code.`,
      retryAfterSec: MIN_SECONDS_BETWEEN_SENDS - since,
    };
  }
  return { ok: true };
}

async function assertCheckAllowed(dbQuery, { phoneE164, purpose }) {
  const checks = await countRecent(dbQuery, {
    phoneE164,
    purpose,
    action: "check",
    sinceMinutes: 60,
  });
  if (checks >= MAX_CHECKS_PER_HOUR) {
    return { ok: false, error: "rate_limited", message: "Too many verification attempts. Try again later." };
  }
  return { ok: true };
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
  if (!isTwilioVerifyConfigured()) {
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
    await recordAttempt(dbQuery, {
      phoneE164: phoneNorm.e164,
      purpose: String(purpose || "customer_phone"),
      actorUserId,
      ipText,
      action: "send",
      result: allowed.error,
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
          action: "send",
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
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(getTwilioVerifyServiceSid())
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
        masked: maskPhoneForDisplay(phoneNorm.e164),
      },
    });

    return {
      ok: true,
      toMasked: maskPhoneForDisplay(phoneNorm.e164),
      status: verification.status,
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
    console.warn("[sms-verify] start failed:", err);
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
  if (!isTwilioVerifyConfigured()) {
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
      action: "check",
      result: allowed.error,
    });
    return allowed;
  }

  try {
    const client = getTwilioClient();
    const check = await client.verify.v2
      .services(getTwilioVerifyServiceSid())
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
    return { ok: false, error: "verify_check_failed", message: "Could not validate verification code." };
  }
}

module.exports = {
  startSmsVerification,
  checkSmsVerification,
  MAX_SENDS_PER_HOUR,
  MAX_CHECKS_PER_HOUR,
  MIN_SECONDS_BETWEEN_SENDS,
};
