/**
 * Outbound SMS via Messaging Service + delivery log.
 * Never throws to callers for provider failures — returns { ok:false }.
 * Does not send payment/booking SMS unless SMS_NOTIFICATIONS_ENABLED=1.
 */
const {
  getTwilioClient,
  getTwilioMessagingServiceSid,
  getTwilioPhoneNumber,
  getOfficialCustomerSmsFromE164,
  isTwilioMessagingConfigured,
} = require("./smsTwilioClient.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");
const { isSmsNotificationsEnabled, smsFlags } = require("./smsFlags.cjs");
const { ensureSmsMessageLogTable } = require("./smsMigrations.cjs");

const CATEGORIES = new Set([
  "booking_created",
  "booking_approved",
  "booking_rescheduled",
  "booking_canceled",
  "booking_completed",
  "booking_reminder",
  "payment_success",
  "payment_failed",
  "payment_denied",
  "payment_refunded",
  "payment_reversed",
  "payment_canceled",
  "security_verify",
  "consent_help",
  "system",
]);

function previewBody(body) {
  return String(body || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

const SUCCESSFUL_SMS_STATUSES = new Set([
  "accepted",
  "queued",
  "sending",
  "sent",
  "delivered",
  "receiving",
  "received",
  "scheduled",
]);

function isSuccessfulSmsLogStatus(status) {
  return SUCCESSFUL_SMS_STATUSES.has(String(status || "").trim().toLowerCase());
}

async function findByIdempotencyKey(dbQuery, key) {
  if (!key) return null;
  const r = await dbQuery(
    `SELECT * FROM sms_message_log WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return r.rows?.[0] || null;
}

async function insertLog(dbQuery, row) {
  await ensureSmsMessageLogTable(dbQuery);
  if (row.idempotencyKey) {
    const existing = await findByIdempotencyKey(dbQuery, row.idempotencyKey);
    if (existing?.id) {
      const upd = await dbQuery(
        `UPDATE sms_message_log
            SET twilio_sid = COALESCE($2, twilio_sid),
                status = COALESCE($3, status),
                to_e164 = COALESCE($4, to_e164),
                from_identity = COALESCE($5, from_identity),
                category = COALESCE($6, category),
                booking_id = COALESCE($7::uuid, booking_id),
                payment_ref = COALESCE($8, payment_ref),
                user_id = COALESCE($9::uuid, user_id),
                body_preview = COALESCE($10, body_preview),
                error_code = $11,
                error_message = $12,
                metadata = COALESCE($13::jsonb, metadata),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          existing.id,
          row.twilioSid || null,
          row.status || "queued",
          row.toE164 || null,
          row.fromIdentity || null,
          row.category,
          row.bookingId || null,
          row.paymentRef || null,
          row.userId || null,
          previewBody(row.body),
          row.errorCode != null ? String(row.errorCode) : null,
          row.errorMessage || null,
          row.metadata ? JSON.stringify(row.metadata) : null,
        ],
      );
      return upd.rows?.[0] || existing;
    }
  }
  const ins = await dbQuery(
    `INSERT INTO sms_message_log
       (twilio_sid, status, to_e164, from_identity, category, booking_id, payment_ref,
        user_id, body_preview, error_code, error_message, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8::uuid,$9,$10,$11,$12,$13::jsonb)
     RETURNING *`,
    [
      row.twilioSid || null,
      row.status || "queued",
      row.toE164 || null,
      row.fromIdentity || null,
      row.category,
      row.bookingId || null,
      row.paymentRef || null,
      row.userId || null,
      previewBody(row.body),
      row.errorCode != null ? String(row.errorCode) : null,
      row.errorMessage || null,
      row.idempotencyKey || null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
  return ins.rows?.[0] || null;
}

async function updateLogBySid(dbQuery, twilioSid, patch) {
  if (!twilioSid || typeof dbQuery !== "function") return;
  await ensureSmsMessageLogTable(dbQuery);
  await dbQuery(
    `UPDATE sms_message_log
     SET status = COALESCE($2, status),
         error_code = COALESCE($3, error_code),
         error_message = COALESCE($4, error_message),
         updated_at = NOW(),
         provider_payload = COALESCE($5::jsonb, provider_payload)
     WHERE twilio_sid = $1`,
    [
      twilioSid,
      patch.status || null,
      patch.errorCode != null ? String(patch.errorCode) : null,
      patch.errorMessage || null,
      patch.providerPayload ? JSON.stringify(patch.providerPayload) : null,
    ],
  );
}

/**
 * Check consent + prefs before transactional send.
 */
async function canSendTransactionalSms(dbQuery, { userId, toE164, category }) {
  try {
    const consent = await dbQuery(
      `SELECT transactional_opt_in, opted_out_at FROM sms_consent
       WHERE phone_e164 = $1 LIMIT 1`,
      [toE164],
    );
    const c = consent.rows?.[0];
    // Fail closed: require an explicit opt-in record (A2P). Missing row = no SMS.
    if (!c || c.transactional_opt_in !== true || c.opted_out_at) {
      return { ok: false, reason: c ? "opted_out" : "no_sms_consent" };
    }
  } catch {
    return { ok: false, reason: "consent_check_failed" };
  }

  if (!userId) return { ok: true };
  try {
    const prefs = await dbQuery(
      `SELECT sms_opt_in, sms_booking_confirmations, sms_reminders, sms_cancellations, sms_payment_updates
       FROM notification_preferences WHERE user_id = $1::uuid LIMIT 1`,
      [userId],
    );
    const p = prefs.rows?.[0];
    if (!p) return { ok: true };
    if (p.sms_opt_in === false) return { ok: false, reason: "sms_opt_in_false" };
    if (String(category).startsWith("booking_reminder") && p.sms_reminders === false) {
      return { ok: false, reason: "pref_reminders_off" };
    }
    if (String(category).includes("cancel") && p.sms_cancellations === false) {
      return { ok: false, reason: "pref_cancellations_off" };
    }
    if (String(category).startsWith("payment_") && p.sms_payment_updates === false) {
      return { ok: false, reason: "pref_payment_off" };
    }
    if (
      (category === "booking_created" ||
        category === "booking_approved" ||
        category === "booking_rescheduled" ||
        category === "booking_completed") &&
      p.sms_booking_confirmations === false
    ) {
      return { ok: false, reason: "pref_booking_off" };
    }
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/**
 * Send transactional SMS (Messaging Service). Idempotent via idempotencyKey.
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, logId?: string, twilioSid?: string }>}
 */
async function sendTransactionalSms(
  dbQuery,
  {
    to,
    body,
    category,
    bookingId = null,
    paymentRef = null,
    userId = null,
    idempotencyKey = null,
    statusCallbackUrl = null,
    force = false,
  } = {},
) {
  const cat = String(category || "system").slice(0, 64);
  if (!CATEGORIES.has(cat) && cat !== "system") {
    return { ok: false, reason: "invalid_category" };
  }

  const phone = normalizeToE164(to);
  if (!phone.ok) return { ok: false, reason: phone.error };

  if (idempotencyKey && typeof dbQuery === "function") {
    try {
      const existing = await findByIdempotencyKey(dbQuery, idempotencyKey);
      // Only treat as sent if Twilio actually accepted the message.
      // Failed / skipped_consent / skipped_flag_off rows must not block a real send.
      if (existing && isSuccessfulSmsLogStatus(existing.status) && existing.twilio_sid) {
        return {
          ok: true,
          skipped: true,
          reason: "idempotent_duplicate",
          logId: existing.id,
          twilioSid: existing.twilio_sid || null,
          status: existing.status || null,
          duplicate: true,
        };
      }
    } catch {
      /* continue */
    }
  }

  if (!force && !isSmsNotificationsEnabled() && cat !== "consent_help" && cat !== "security_verify") {
    if (smsFlags().logSkipped && typeof dbQuery === "function") {
      const log = await insertLog(dbQuery, {
        status: "skipped_flag_off",
        toE164: phone.e164,
        fromIdentity: getOfficialCustomerSmsFromE164(),
        category: cat,
        bookingId,
        paymentRef,
        userId,
        body,
        idempotencyKey,
        metadata: {
          maskedTo: maskPhoneForDisplay(phone.e164),
          duplicateOrIdempotent: false,
        },
      }).catch(() => null);
      return { ok: true, skipped: true, reason: "sms_notifications_disabled", logId: log?.id };
    }
    return { ok: true, skipped: true, reason: "sms_notifications_disabled" };
  }

  if (typeof dbQuery === "function" && !force) {
    const allowed = await canSendTransactionalSms(dbQuery, {
      userId,
      toE164: phone.e164,
      category: cat,
    });
    if (!allowed.ok) {
      const log = await insertLog(dbQuery, {
        status: "skipped_consent",
        toE164: phone.e164,
        fromIdentity: getOfficialCustomerSmsFromE164(),
        category: cat,
        bookingId,
        paymentRef,
        userId,
        body,
        idempotencyKey,
        errorMessage: allowed.reason,
        metadata: { duplicateOrIdempotent: false },
      }).catch(() => null);
      return { ok: true, skipped: true, reason: allowed.reason, logId: log?.id };
    }
  }

  if (!isTwilioMessagingConfigured()) {
    const log =
      typeof dbQuery === "function"
        ? await insertLog(dbQuery, {
            status: "failed",
            toE164: phone.e164,
            category: cat,
            bookingId,
            paymentRef,
            userId,
            body,
            idempotencyKey,
            errorMessage: "twilio_messaging_not_configured",
          }).catch(() => null)
        : null;
    return { ok: false, reason: "twilio_messaging_not_configured", logId: log?.id };
  }

  const client = getTwilioClient();
  const messagingServiceSid = getTwilioMessagingServiceSid();
  // Official customer-facing From (must already be in Messaging Service sender pool).
  const fromE164 = getOfficialCustomerSmsFromE164();
  const createParams = {
    to: phone.e164,
    body: String(body || "").slice(0, 1500),
    messagingServiceSid,
    from: fromE164,
  };
  if (statusCallbackUrl) createParams.statusCallback = statusCallbackUrl;

  try {
    const msg = await client.messages.create(createParams);
    const twilioSid = msg.sid || null;
    const createStatus = String(msg.status || "queued").toLowerCase();
    console.log("[sms] twilio create OK", {
      category: cat,
      bookingId,
      twilioSid,
      status: createStatus,
      to: maskPhoneForDisplay(phone.e164),
      from: fromE164,
      messagingServiceSid: messagingServiceSid ? `${String(messagingServiceSid).slice(0, 4)}…` : null,
    });
    const log =
      typeof dbQuery === "function"
        ? await insertLog(dbQuery, {
            twilioSid,
            status: createStatus,
            toE164: phone.e164,
            fromIdentity: fromE164,
            category: cat,
            bookingId,
            paymentRef,
            userId,
            body,
            idempotencyKey,
            metadata: {
              maskedTo: maskPhoneForDisplay(phone.e164),
              messagingServiceSid,
              fromE164,
            },
          }).catch(() => null)
        : null;
    return {
      ok: true,
      logId: log?.id || null,
      twilioSid,
      status: createStatus,
      to: phone.e164,
      maskedTo: maskPhoneForDisplay(phone.e164),
      errorCode: msg.errorCode || msg.error_code || null,
      errorMessage: msg.errorMessage || msg.error_message || null,
    };
  } catch (e) {
    const err = e?.message || String(e);
    const code = e?.code || e?.status || null;
    console.error("[sms] twilio create FAILED", {
      category: cat,
      bookingId,
      to: maskPhoneForDisplay(phone.e164),
      error: err,
      errorCode: code,
      from: fromE164,
      messagingServiceSid: messagingServiceSid ? `${String(messagingServiceSid).slice(0, 4)}…` : null,
    });
    const log =
      typeof dbQuery === "function"
        ? await insertLog(dbQuery, {
            status: "failed",
            toE164: phone.e164,
            fromIdentity: fromE164 || messagingServiceSid || getTwilioPhoneNumber() || null,
            category: cat,
            bookingId,
            paymentRef,
            userId,
            body,
            idempotencyKey,
            errorCode: code,
            errorMessage: err,
          }).catch(() => null)
        : null;
    return {
      ok: false,
      reason: "send_failed",
      error: err,
      errorCode: code,
      logId: log?.id,
      maskedTo: maskPhoneForDisplay(phone.e164),
    };
  }
}

module.exports = {
  CATEGORIES,
  sendTransactionalSms,
  updateLogBySid,
  findByIdempotencyKey,
  canSendTransactionalSms,
  isSuccessfulSmsLogStatus,
};
