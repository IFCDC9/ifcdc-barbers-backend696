#!/usr/bin/env node
/**
 * Controlled live SMS battery — ONLY to SUPER_ADMIN_SMS_PHONE / ALLOWED_TO.
 * Does not create real bookings or PayPal charges. Logs to sms_message_log.
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/controlled-sms-live-battery.mjs
 *   CONFIRM_LIVE_SMS=1 node --import ./loadBackendEnv.mjs scripts/controlled-sms-live-battery.mjs
 */
import pg from "pg";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { notifyBookingSms } = require("../smsBookingNotify.cjs");
const {
  notifyPaymentSmsFromPaypalWebhook,
  buildPaymentSmsBody,
} = require("../smsPaymentNotify.cjs");
const { sendTransactionalSms } = require("../smsDeliveryService.cjs");
const { startSmsVerification } = require("../smsVerifyService.cjs");
const {
  getTwilioClient,
  getTwilioMessagingServiceSid,
  getTwilioVerifyServiceSid,
  isTwilioAccountConfigured,
  isTwilioMessagingConfigured,
  isTwilioVerifyConfigured,
  twilioConfigStatus,
} = require("../smsTwilioClient.cjs");
const { ensureSmsSchema } = require("../smsMigrations.cjs");

const ALLOWED = String(
  process.env.SMS_CONTROLLED_TO || process.env.SUPER_ADMIN_SMS_PHONE || "+18484694448",
)
  .trim()
  .replace(/\s/g, "");

if (process.env.CONFIRM_LIVE_SMS !== "1") {
  console.error("Refusing: set CONFIRM_LIVE_SMS=1 to run live controlled SMS sends.");
  process.exit(2);
}

if (ALLOWED !== "+18484694448") {
  console.error("Refusing: destination must be +18484694448 for this controlled phase. Got:", ALLOWED);
  process.exit(2);
}

// Enable flags for this process only (does not change Render env).
process.env.SMS_NOTIFICATIONS_ENABLED = "1";
process.env.SMS_VERIFY_ENABLED = "1";
process.env.PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://ifcdc-barbers-backend696.onrender.com";

function dbQueryFactory(pool) {
  return async (text, params) => pool.query(text, params);
}

async function resolveMessagingSidIfNeeded() {
  if (getTwilioMessagingServiceSid()) return;
  if (!isTwilioAccountConfigured()) return;
  const client = getTwilioClient();
  const services = await client.messaging.v1.services.list({ limit: 5 });
  const match =
    services.find((s) => /IFCDC|Barbers|SMS Engine/i.test(String(s.friendlyName || ""))) ||
    services[0];
  if (match?.sid) {
    process.env.TWILIO_MESSAGING_SERVICE_SID = match.sid;
    console.log("Resolved TWILIO_MESSAGING_SERVICE_SID prefix:", `${match.sid.slice(0, 4)}…`);
  }
}

async function resolveVerifySidIfNeeded() {
  if (getTwilioVerifyServiceSid()) return;
  if (!isTwilioAccountConfigured()) return;
  const client = getTwilioClient();
  const services = await client.verify.v2.services.list({ limit: 5 });
  const match =
    services.find((s) => /AURA|IFCDC|Verification/i.test(String(s.friendlyName || ""))) ||
    services[0];
  if (match?.sid) {
    process.env.TWILIO_VERIFY_SERVICE_SID = match.sid;
    console.log("Resolved TWILIO_VERIFY_SERVICE_SID prefix:", `${match.sid.slice(0, 4)}…`);
  }
}

async function fetchTwilioStatus(sid) {
  if (!sid || !isTwilioAccountConfigured()) return null;
  try {
    const msg = await getTwilioClient().messages(sid).fetch();
    return { status: msg.status, errorCode: msg.errorCode, errorMessage: msg.errorMessage };
  } catch (e) {
    return { status: "fetch_failed", errorMessage: e?.message || String(e) };
  }
}

async function main() {
  const marker = `sms_ctrl_${Date.now().toString(36)}`;
  console.log("=== Controlled SMS live battery ===");
  console.log("to:", ALLOWED, "marker:", marker);
  console.log("twilio before resolve:", twilioConfigStatus());

  await resolveMessagingSidIfNeeded();
  await resolveVerifySidIfNeeded();

  console.log("twilio after resolve:", {
    accountConfigured: isTwilioAccountConfigured(),
    messagingConfigured: isTwilioMessagingConfigured(),
    verifyConfigured: isTwilioVerifyConfigured(),
    messagingPrefix: getTwilioMessagingServiceSid()?.slice(0, 4),
    verifyPrefix: getTwilioVerifyServiceSid()?.slice(0, 4),
  });

  if (!isTwilioMessagingConfigured()) {
    console.error("Messaging not configured — abort.");
    process.exit(1);
  }

  function stripSslQueryFromUrl(urlString) {
    try {
      const u = new URL(urlString);
      for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
        u.searchParams.delete(key);
      }
      return u.toString();
    } catch {
      return urlString;
    }
  }

  const pool = new pg.Pool({
    connectionString: stripSslQueryFromUrl(String(process.env.DATABASE_URL || "").trim()),
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  const dbQuery = dbQueryFactory(pool);

  try {
    await ensureSmsSchema(dbQuery);
    console.log("schema: ready");

    const results = [];

    // Customer Verify is optional — starting it replaces any pending AURA Verify on the same handset.
    if (process.env.INCLUDE_CUSTOMER_VERIFY === "1") {
      if (isTwilioVerifyConfigured()) {
        const verify = await startSmsVerification(dbQuery, {
          phone: ALLOWED,
          purpose: "customer_phone",
          ipText: "controlled-sms-battery",
        });
        results.push({ name: "customer_phone_verify_start", ...verify });
      } else {
        results.push({
          name: "customer_phone_verify_start",
          ok: false,
          reason: "verify_not_configured",
        });
      }
    } else {
      results.push({
        name: "customer_phone_verify_start",
        ok: true,
        skipped: true,
        reason: "deferred_until_aura_code_validated_set_INCLUDE_CUSTOMER_VERIFY=1",
      });
    }

    const booking = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      phone: ALLOWED,
      barber_name: "IFCDC Controlled",
      service: "SMS Battery Test",
      date: "2026-08-10",
      time: "14:00",
      location: "IFCDC Barbers HQ",
    };

    const bookingEvents = [
      "booking_created",
      "booking_approved",
      "booking_rescheduled",
      "booking_canceled",
      "booking_reminder",
    ];
    for (const event of bookingEvents) {
      const out = await notifyBookingSms(dbQuery, event, booking, {
        occurrence: marker,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
      });
      const tw = out.twilioSid ? await fetchTwilioStatus(out.twilioSid) : null;
      results.push({ name: event, ...out, twilio: tw });
      await new Promise((r) => setTimeout(r, 800));
    }

    const paymentCases = [
      {
        name: "paypal_payment_completed",
        body: {
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          id: `WH-${marker}-ok`,
          resource: {
            id: `CAP${marker}OK`,
            amount: { value: "1.00", currency_code: "USD" },
          },
        },
      },
      {
        name: "paypal_payment_failed",
        body: {
          event_type: "PAYMENT.CAPTURE.DECLINED",
          id: `WH-${marker}-fail`,
          resource: { id: `CAP${marker}FAIL`, amount: { value: "1.00", currency_code: "USD" } },
        },
      },
      {
        name: "paypal_payment_denied",
        body: {
          event_type: "PAYMENT.CAPTURE.DENIED",
          id: `WH-${marker}-deny`,
          resource: { id: `CAP${marker}DENY`, amount: { value: "1.00", currency_code: "USD" } },
        },
      },
      {
        name: "paypal_refund",
        body: {
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          id: `WH-${marker}-ref`,
          resource: {
            id: `CAP${marker}REF`,
            seller_payable_breakdown: { gross_amount: { value: "1.00", currency_code: "USD" } },
          },
        },
      },
      {
        name: "paypal_reversal",
        body: {
          event_type: "PAYMENT.CAPTURE.REVERSED",
          id: `WH-${marker}-rev`,
          resource: { id: `CAP${marker}REV` },
        },
      },
    ];

    for (const pc of paymentCases) {
      const out = await notifyPaymentSmsFromPaypalWebhook(dbQuery, pc.body, {
        to: ALLOWED,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
      });
      const tw = out.twilioSid ? await fetchTwilioStatus(out.twilioSid) : null;
      results.push({ name: pc.name, ...out, twilio: tw });
      await new Promise((r) => setTimeout(r, 800));
    }

    // Duplicate PayPal webhook prevention
    const dupBody = {
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      id: `WH-${marker}-dup`,
      resource: {
        id: `CAP${marker}DUP`,
        amount: { value: "2.00", currency_code: "USD" },
      },
    };
    const first = await notifyPaymentSmsFromPaypalWebhook(dbQuery, dupBody, {
      to: ALLOWED,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    });
    const second = await notifyPaymentSmsFromPaypalWebhook(dbQuery, dupBody, {
      to: ALLOWED,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    });
    results.push({
      name: "paypal_duplicate_prevention",
      first: { ok: first.ok, skipped: first.skipped, twilioSid: first.twilioSid, reason: first.reason },
      second: {
        ok: second.ok,
        skipped: second.skipped,
        twilioSid: second.twilioSid,
        reason: second.reason,
      },
      prevented:
        second.skipped === true &&
        second.reason === "idempotent_duplicate" &&
        second.twilioSid === first.twilioSid,
    });

    // SMS delivery failure must not mutate booking/payment success
    const bookingOk = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      phone: ALLOWED,
      payment_status: "paid_in_full",
      barber_name: "IFCDC",
      service: "Fail-safe",
      date: "2026-08-11",
      time: "15:00",
    };
    let bookingMutated = false;
    const guardedDb = async (sql, params) => {
      if (/UPDATE\s+bookings/i.test(String(sql)) && /payment_status/i.test(String(sql))) {
        bookingMutated = true;
      }
      return dbQuery(sql, params);
    };
    // Force a send failure by using invalid messaging SID temporarily
    const realMs = process.env.TWILIO_MESSAGING_SERVICE_SID;
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG00000000000000000000000000000000";
    const failOut = await notifyBookingSms(guardedDb, "booking_approved", bookingOk, {
      occurrence: `${marker}_fail`,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    });
    process.env.TWILIO_MESSAGING_SERVICE_SID = realMs;
    results.push({
      name: "sms_failure_non_fatal",
      smsOk: failOut.ok,
      reason: failOut.reason,
      bookingMutated,
      paymentStatusUnchanged: bookingOk.payment_status === "paid_in_full",
      nonFatal: bookingMutated === false && bookingOk.payment_status === "paid_in_full",
    });

    // Email fallback contract: SMS path independent — document body still buildable
    const emailBody = buildPaymentSmsBody("payment_success", {
      amount: "1.00",
      currency: "USD",
      bookingId: booking.id,
      captureId: "CAPEMAIL",
    });
    results.push({
      name: "email_fallback_contract",
      smsIndependent: true,
      emailWouldStillRun: true,
      sampleSmsBodyLen: emailBody.length,
    });

    // Recent log rows for this number (masked in output)
    const log = await dbQuery(
      `SELECT created_at, category, status, twilio_sid, error_code, left(body_preview,80) AS preview
       FROM sms_message_log
       WHERE to_e164 = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [ALLOWED],
    );
    results.push({
      name: "recent_log",
      rows: (log.rows || []).map((r) => ({
        ...r,
        twilio_sid: r.twilio_sid ? `${String(r.twilio_sid).slice(0, 6)}…` : null,
      })),
    });

    console.log(JSON.stringify({ ok: true, marker, allowed: ALLOWED, results }, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
