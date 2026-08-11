import twilio from "twilio";
import { dbQuery } from "./db.js";

/** One automatic resend per outbound MessageSid (Twilio may POST status more than once). */
const retried30034MessageSids = new Set();
const RETRY_SET_MAX = 2000;

function note30034Retry(messageSid) {
  if (retried30034MessageSids.size >= RETRY_SET_MAX) {
    retried30034MessageSids.clear();
  }
  retried30034MessageSids.add(messageSid);
}

function alreadyRetried30034(messageSid) {
  return retried30034MessageSids.has(messageSid);
}

function stripOuterQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Twilio Messaging Service SID: `MG` + 32 hex (no spaces). */
function normalizeMessagingServiceSid() {
  return stripOuterQuotes(process.env.TWILIO_MESSAGING_SERVICE_SID).replace(/\s/g, "");
}

/** Official customer-facing SMS From (must already be in Messaging Service sender pool). */
const OFFICIAL_CUSTOMER_SMS_FROM_E164 = "+19895141064";

function getOfficialCustomerSmsFromE164() {
  return OFFICIAL_CUSTOMER_SMS_FROM_E164;
}

function normalizeFallbackFromE164() {
  return stripOuterQuotes(process.env.TWILIO_SMS_FALLBACK_FROM || "").replace(/\s/g, "");
}

/** US mobile → `+1` + 10 digits for Twilio `to`. */
function toNanpE164(phone) {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  d = d.slice(-10);
  if (d.length !== 10) return null;
  return `+1${d}`;
}

/** Debug: send to another handset (carrier / self-send isolation). E.164 e.g. +15551234567 */
function normalizeSmsOverrideTo() {
  const v = stripOuterQuotes(process.env.TWILIO_SMS_OVERRIDE_TO || "").replace(/\s/g, "");
  if (!v) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(v)) {
    console.error("[SMS] TWILIO_SMS_OVERRIDE_TO must be E.164 (+country…). Got:", v);
    return null;
  }
  return v;
}

function logTwilioCreateResponse(msg) {
  console.log("📤 TWILIO RESPONSE:", {
    sid: msg.sid,
    status: msg.status,
    errorCode: msg.errorCode ?? null,
    errorMessage: msg.errorMessage ?? null,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSmsDeliveredOk(status) {
  const s = String(status || "").toLowerCase();
  return s === "sent" || s === "delivered";
}

const TERMINAL_BAD = new Set(["failed", "undelivered", "canceled", "cancelled"]);

/**
 * Poll Twilio until sent/delivered, terminal failure, or timeout.
 * @returns {{ deliveredOk: boolean; status: string; errorCode: string | number | null; errorMessage: string | null; messageSid: string; timedOut?: boolean }}
 */
async function pollMessageDelivery(client, messageSid, maxWaitMs, intervalMs) {
  const start = Date.now();
  let last = {
    deliveredOk: false,
    status: "",
    errorCode: null,
    errorMessage: null,
    messageSid,
  };
  while (Date.now() - start < maxWaitMs) {
    const m = await client.messages(messageSid).fetch();
    const st = String(m.status || "").toLowerCase();
    const errorCode = m.errorCode ?? null;
    const errorMessage = m.errorMessage != null ? String(m.errorMessage) : null;
    last = {
      deliveredOk: isSmsDeliveredOk(st),
      status: st,
      errorCode,
      errorMessage,
      messageSid: m.sid || messageSid,
    };
    if (last.deliveredOk) return last;
    if (TERMINAL_BAD.has(st)) return last;
    await sleep(intervalMs);
  }
  return { ...last, timedOut: true };
}

async function persistBookingSmsByBookingId(bookingId, row) {
  if (!bookingId) return;
  try {
    await dbQuery(
      `UPDATE bookings SET
         sms_status = $1,
         sms_error_code = $2,
         sms_error_message = $3,
         message_sid = $4
       WHERE id = $5::uuid`,
      [
        row.status || null,
        row.deliveredOk ? null : row.errorCode != null ? String(row.errorCode) : null,
        row.deliveredOk ? null : row.errorMessage || null,
        row.messageSid || null,
        bookingId,
      ],
    );
  } catch (e) {
    console.error("[SMS] persist booking SMS fields failed:", e?.message || e);
  }
}

async function persistBookingSmsByMessageSid(messageSid, status, errorCode, errorMessage) {
  if (!messageSid) return;
  try {
    await dbQuery(
      `UPDATE bookings SET
         sms_status = $1,
         sms_error_code = $2,
         sms_error_message = $3
       WHERE message_sid = $4`,
      [status || null, errorCode != null ? String(errorCode) : null, errorMessage || null, messageSid],
    );
  } catch (e) {
    console.error("[SMS] persist by message_sid failed:", e?.message || e);
  }
}

/**
 * Booking SMS — Twilio Messaging Service (or direct / fallback debug paths).
 *
 * @param {{ phone?: string; date?: string; dateYmd?: string; time?: string; smsBody?: string }} data
 * @param {{ bookingId?: string | null }} [opts] — when set, persists sms_status / sms_error_code / message_sid on `bookings`
 * @returns {Promise<{ success: boolean; delivered?: boolean; messageSid?: string; lastStatus?: string; errorCode?: string | number | null; errorMessage?: string | null; reason?: string; via?: string }>}
 */
export async function sendConfirmationSMS(data, opts = {}) {
  const bookingId = opts.bookingId ? String(opts.bookingId).trim() : null;
  const overrideTo = normalizeSmsOverrideTo();
  const to = overrideTo || toNanpE164(data?.phone);
  if (overrideTo) {
    console.warn("[SMS] TWILIO_SMS_OVERRIDE_TO — delivering to debug handset:", overrideTo);
  }

  if (!to) {
    console.error("[SMS] Need TWILIO_SMS_OVERRIDE_TO (+E.164) or a 10-digit US mobile in data.phone. Got:", data?.phone);
    return { success: false, reason: "invalid_phone" };
  }

  const message =
    String(data?.smsBody ?? "").trim() ||
    `IFCDC: Your appointment is confirmed for ${String(data?.dateYmd || data?.date || "your date").trim()} at ${String(data?.time || "your time").trim()}.`;

  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const fallbackFrom = normalizeFallbackFromE164();
  const allowFallback =
    fallbackFrom && String(process.env.TWILIO_SMS_FALLBACK_ON_30034 || "1").trim() !== "0";

  const maxPollMs = Number(process.env.SMS_DELIVERY_POLL_MAX_MS || 35000);
  const pollEvery = Number(process.env.SMS_DELIVERY_POLL_INTERVAL_MS || 1500);

  const forceDirect = String(process.env.TWILIO_SMS_FORCE_DIRECT || "").trim() === "1";
  if (forceDirect) {
    const from = stripOuterQuotes(
      process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_SMS_FROM || "",
    ).replace(/\s/g, "");
    if (!from) {
      console.error(
        "[SMS] TWILIO_SMS_FORCE_DIRECT=1 requires TWILIO_PHONE_NUMBER or TWILIO_SMS_FROM (your +1 sender).",
      );
      return { success: false, reason: "missing_from_for_direct_test" };
    }
    const body = String(process.env.TWILIO_SMS_DIRECT_TEST_BODY || "DIRECT TEST IFCDC").trim();
    console.warn(
      "[SMS] TWILIO_SMS_FORCE_DIRECT=1 — bypassing Messaging Service (remove after carrier debugging).",
    );
    return runDeliveryAttempts({
      bookingId,
      maxPollMs,
      pollEvery,
      sendOnce: async (client) => {
        const msg = await client.messages.create({ body, from, to });
        logTwilioCreateResponse(msg);
        return msg.sid;
      },
    });
  }

  const messagingServiceSid = normalizeMessagingServiceSid();
  if (!messagingServiceSid) {
    console.error(
      "[SMS] TWILIO_MESSAGING_SERVICE_SID is empty. Set it in backend/.env to your Messaging Service SID (Console → Messaging → Services → copy SID starting with MG).",
    );
    return { success: false, reason: "missing_TWILIO_MESSAGING_SERVICE_SID" };
  }

  if (!/^MG[a-f0-9]{32}$/i.test(messagingServiceSid)) {
    console.error(
      "[SMS] TWILIO_MESSAGING_SERVICE_SID must be MG + 32 hex characters. Got length",
      messagingServiceSid.length,
      "preview:",
      `${messagingServiceSid.slice(0, 4)}…`,
    );
    return { success: false, reason: "invalid_TWILIO_MESSAGING_SERVICE_SID_format" };
  }

  return runDeliveryAttempts({
    bookingId,
    maxPollMs,
    pollEvery,
    sendOnce: async (client) => {
      try {
        const msg = await client.messages.create({
          body: message,
          to,
          messagingServiceSid,
          from: getOfficialCustomerSmsFromE164(),
        });
        logTwilioCreateResponse(msg);
        return msg.sid;
      } catch (err) {
        const code = err?.code;
        const is30034 = code === 30034 || code === "30034";
        if (is30034 && allowFallback) {
          try {
            const msg2 = await client.messages.create({
              body: message,
              to,
              from: fallbackFrom,
            });
            logTwilioCreateResponse(msg2);
            return { sid: msg2.sid, via: "fallback_from" };
          } catch (err2) {
            console.error("❌ SMS FAILED (fallback from after 30034):", err2);
          }
        }
        if (is30034) {
          console.error(
            "[SMS 30034] US A2P 10DLC — unregistered / non-compliant +1 long code on this Messaging Service. Fix: Twilio Console → Trust Hub → A2P 10DLC (brand + campaign) and attach your sender to the Messaging Service. Docs: https://www.twilio.com/docs/api/errors/30034 — Optional: set TWILIO_SMS_FALLBACK_FROM to a Twilio-verified toll-free (+1 8xx…) for automatic resend.",
          );
        }
        throw err;
      }
    },
  });
}

/**
 * Two attempts: create + poll; if not delivered, wait 2s and repeat.
 */
async function runDeliveryAttempts({ bookingId, maxPollMs, pollEvery, sendOnce }) {
  const client = twilio(
    String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
  );

  let last = {
    success: false,
    delivered: false,
    lastStatus: "",
    errorCode: null,
    errorMessage: null,
    messageSid: "",
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const created = await sendOnce(client);
      const messageSid = typeof created === "string" ? created : created.sid;
      const via = typeof created === "object" && created?.via ? created.via : undefined;

      const polled = await pollMessageDelivery(client, messageSid, maxPollMs, pollEvery);
      await persistBookingSmsByBookingId(bookingId, polled);

      if (polled.deliveredOk) {
        return {
          success: true,
          delivered: true,
          messageSid: polled.messageSid,
          lastStatus: polled.status,
          via,
        };
      }

      console.error("❌ SMS NOT DELIVERED:", polled.errorCode, polled.errorMessage);
      last = {
        success: false,
        delivered: false,
        lastStatus: polled.status,
        errorCode: polled.errorCode,
        errorMessage: polled.errorMessage,
        messageSid: polled.messageSid,
        reason: polled.timedOut ? "delivery_timeout" : polled.status,
        via,
      };
    } catch (err) {
      console.error("❌ SMS FAILED:", err);
      last = {
        success: false,
        delivered: false,
        lastStatus: "api_error",
        errorCode: err?.code ?? null,
        errorMessage: err?.message != null ? String(err.message) : String(err),
        messageSid: "",
        reason: err?.message != null ? String(err.message) : "send_failed",
      };
      if (bookingId) {
        await persistBookingSmsByBookingId(bookingId, {
          deliveredOk: false,
          status: "api_error",
          errorCode: last.errorCode,
          errorMessage: last.errorMessage,
          messageSid: null,
        });
      }
    }

    if (attempt < 2) {
      await sleep(2000);
    }
  }

  return last;
}

/**
 * Twilio status callback (`POST /api/sms/status`). Updates `bookings` by `message_sid`; optional 30034 resend.
 *
 * @param {Record<string, string | undefined>} body — urlencoded Twilio payload
 */
export async function handleTwilioSmsStatusCallback(body) {
  const raw = body && typeof body === "object" ? body : {};
  const messageSid = String(raw.MessageSid || raw.SmsSid || "").trim();
  const status = String(raw.MessageStatus || raw.SmsStatus || "").trim().toLowerCase();
  const errorCode = String(raw.ErrorCode ?? "").trim();
  const errorMessage = String(raw.ErrorMessage ?? raw.error_message ?? "").trim() || null;

  if (messageSid && status) {
    await persistBookingSmsByMessageSid(messageSid, status, errorCode || null, errorMessage);
  }

  if (status === "failed" || status === "undelivered") {
    if (errorCode === "30034") {
      console.error(
        "[SMS 30034] undelivered — US carrier blocked A2P 10DLC sender. Register the long code on an approved campaign (Messaging Service → Compliance) or use a verified toll-free as TWILIO_SMS_FALLBACK_FROM. https://www.twilio.com/docs/api/errors/30034",
        { to: raw.To, messageSid },
      );
    } else if (errorCode) {
      console.error("[SMS undelivered/failed]", {
        errorCode,
        messageSid,
        to: raw.To,
        from: raw.From,
      });
    }
  }

  if (status !== "undelivered" || errorCode !== "30034" || !messageSid) return;
  if (String(process.env.TWILIO_SMS_FALLBACK_ON_30034 || "1").trim() === "0") return;

  const fallbackFrom = normalizeFallbackFromE164();
  if (!fallbackFrom) return;
  if (alreadyRetried30034(messageSid)) return;
  note30034Retry(messageSid);

  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) {
    retried30034MessageSids.delete(messageSid);
    return;
  }

  try {
    const client = twilio(accountSid, authToken);
    const fetched = await client.messages(messageSid).fetch();
    const text = String(fetched.body || "").trim();
    const dest = String(fetched.to || raw.To || "").trim();
    if (!text || !dest) {
      console.error("❌ SMS 30034 retry skipped: missing body or to after fetch", { messageSid });
      retried30034MessageSids.delete(messageSid);
      return;
    }
    const out = await client.messages.create({
      body: text,
      to: dest,
      from: fallbackFrom,
    });
    logTwilioCreateResponse(out);
    console.log("📤 SMS queued (30034 webhook retry)", {
      via: "TWILIO_SMS_FALLBACK_FROM",
      originalMessageSid: messageSid,
    });
  } catch (e) {
    retried30034MessageSids.delete(messageSid);
    console.error("❌ SMS FAILED (30034 webhook retry):", e);
  }
}

export const sendVoiceBookingConfirmationSms = sendConfirmationSMS;
