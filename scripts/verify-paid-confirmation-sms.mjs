#!/usr/bin/env node
/**
 * Live verification of the paid-booking confirmation SMS path.
 * Uses production DB + Twilio from local .env (loadBackendEnv.mjs).
 *
 *   node --import ./loadBackendEnv.mjs scripts/verify-paid-confirmation-sms.mjs
 *   node --import ./loadBackendEnv.mjs scripts/verify-paid-confirmation-sms.mjs --send
 *   node --import ./loadBackendEnv.mjs scripts/verify-paid-confirmation-sms.mjs --booking=UUID --send
 *
 * Default is inspect-only. Pass --send to actually call Twilio for the latest
 * paid booking (or --booking). Does not create a new PayPal charge.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const { notifyPaidBookingConfirmationSms, resolvePhoneAsync } = require("../smsBookingNotify.cjs");
const { maskPhoneForDisplay, normalizeToE164 } = require("../smsPhone.cjs");
const {
  getTwilioClient,
  twilioConfigStatus,
  getOfficialCustomerSmsFromE164,
  getTwilioMessagingServiceSid,
  isTwilioAccountConfigured,
  isTwilioMessagingConfigured,
} = require("../smsTwilioClient.cjs");
const { smsFlags } = require("../smsFlags.cjs");
const { PAYMENT_STATUS, isBookingPaymentSettled } = require("../bookingPaymentSettlement.cjs");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
}

const DO_SEND = process.argv.includes("--send");
const bookingIdArg = arg("booking");
const captureArg = arg("capture");

function maskId(id) {
  const s = String(id || "");
  if (s.length < 8) return s || null;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function loadBooking() {
  if (bookingIdArg) {
    const r = await dbQuery(`SELECT * FROM bookings WHERE id = $1::uuid LIMIT 1`, [bookingIdArg]);
    return r.rows?.[0] || null;
  }
  if (captureArg) {
    const r = await dbQuery(`SELECT * FROM bookings WHERE paypal_capture_id = $1 LIMIT 1`, [captureArg]);
    return r.rows?.[0] || null;
  }
  const attempts = [
    `SELECT * FROM bookings
      WHERE paypal_capture_id IS NOT NULL AND paypal_capture_id <> ''
        AND payment_status ILIKE '%paid%'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1`,
    `SELECT * FROM bookings
      WHERE paypal_capture_id IS NOT NULL AND paypal_capture_id <> ''
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1`,
    `SELECT * FROM bookings
      WHERE paypal_capture_id IS NOT NULL AND paypal_capture_id <> ''
      ORDER BY date DESC, time DESC
      LIMIT 1`,
  ];
  for (const sql of attempts) {
    try {
      const r = await dbQuery(sql);
      if (r.rows?.[0]) return r.rows[0];
    } catch (e) {
      console.warn("[verify-sms] booking query fallback:", e?.message || e);
    }
  }
  return null;
}

async function resolveMessagingSidIfNeeded() {
  if (getTwilioMessagingServiceSid()) return;
  if (!isTwilioAccountConfigured()) return;
  const client = getTwilioClient();
  const services = await client.messaging.v1.services.list({ limit: 8 });
  const match =
    services.find((s) => /IFCDC|Barbers|SMS Engine/i.test(String(s.friendlyName || ""))) ||
    services[0];
  if (match?.sid) {
    process.env.TWILIO_MESSAGING_SERVICE_SID = match.sid;
    console.log("[verify-sms] resolved messaging service prefix", `${match.sid.slice(0, 4)}…`);
  }
}

async function fetchTwilioStatus(sid) {
  if (!sid) return null;
  const client = getTwilioClient();
  if (!client) return null;
  try {
    const msg = await client.messages(sid).fetch();
    return {
      sid: msg.sid,
      status: msg.status,
      errorCode: msg.errorCode || null,
      errorMessage: msg.errorMessage || null,
      from: msg.from || null,
      toMasked: maskPhoneForDisplay(msg.to),
    };
  } catch (e) {
    return { fetchError: e?.message || String(e) };
  }
}

async function pollDelivery(sid, attempts = 6) {
  let last = await fetchTwilioStatus(sid);
  for (let i = 0; i < attempts; i++) {
    const st = String(last?.status || "").toLowerCase();
    if (["delivered", "undelivered", "failed", "canceled"].includes(st) || last?.errorCode) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 2000));
    last = await fetchTwilioStatus(sid);
  }
  return last;
}

const report = {
  paypalCaptureSucceeded: null,
  bookingId: null,
  captureId: null,
  paymentStatus: null,
  bookingStatus: null,
  phoneAttached: null,
  phoneE164Valid: null,
  smsFunctionCalled: false,
  twilioSid: null,
  twilioDeliveryStatus: null,
  twilioError: null,
  sendSkipped: null,
};

try {
  process.env.SMS_NOTIFICATIONS_ENABLED = process.env.SMS_NOTIFICATIONS_ENABLED || "1";
  process.env.PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "https://ifcdc-barbers-backend696.onrender.com";
  await resolveMessagingSidIfNeeded();
  const flags = smsFlags();
  const twilio = twilioConfigStatus();
  console.log("[verify-sms] flags", {
    notificationsEnabled: flags.notificationsEnabled,
    verifyEnabled: flags.verifyEnabled,
  });
  console.log("[verify-sms] twilio", {
    accountConfigured: twilio.accountConfigured,
    messagingConfigured: twilio.messagingConfigured,
    messagingServiceSidPrefix: twilio.messagingServiceSidPrefix,
    from: getOfficialCustomerSmsFromE164(),
    messagingServiceSidPresent: Boolean(getTwilioMessagingServiceSid()),
  });

  const booking = await loadBooking();
  if (!booking) {
    console.error("[verify-sms] no paid booking found");
    process.exit(1);
  }

  const captureId = String(booking.paypal_capture_id || "").trim();
  const paid = isBookingPaymentSettled(booking) || /paid/i.test(String(booking.payment_status || ""));
  const resolved = await resolvePhoneAsync(dbQuery, booking);
  const phoneRaw = booking.phone || booking.customer_phone || booking.phone_e164 || resolved || "";
  const phoneNorm = normalizeToE164(phoneRaw);

  report.paypalCaptureSucceeded = Boolean(captureId);
  report.bookingId = booking.id;
  report.captureId = captureId;
  report.paymentStatus = booking.payment_status || null;
  report.bookingStatus = booking.booking_status || null;
  report.phoneAttached = phoneNorm.ok ? maskPhoneForDisplay(phoneNorm.e164) : phoneRaw ? maskPhoneForDisplay(phoneRaw) : null;
  report.phoneE164Valid = phoneNorm.ok;

  console.log("[verify-sms] booking", {
    id: booking.id,
    captureId: maskId(captureId),
    paymentStatus: booking.payment_status,
    bookingStatus: booking.booking_status,
    paid,
    phone: report.phoneAttached,
    phoneE164Valid: phoneNorm.ok,
  });

  if (!DO_SEND) {
    console.log("[verify-sms] inspect-only (pass --send to call Twilio)");
    console.log(JSON.stringify({ ...report, smsFunctionCalled: false, note: "inspect_only" }, null, 2));
    process.exit(report.paypalCaptureSucceeded && report.phoneE164Valid ? 0 : 2);
  }

  if (!captureId || !paid) {
    report.twilioError = `Booking is not a verified paid capture (status=${booking.payment_status})`;
    console.error("[verify-sms]", report.twilioError);
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const sms = await notifyPaidBookingConfirmationSms(
    dbQuery,
    {
      ...booking,
      phone: phoneNorm.ok ? phoneNorm.e164 : booking.phone,
      payment_status: booking.payment_status || PAYMENT_STATUS.PAID_IN_FULL,
    },
    {
      captureId,
      alreadySettled: true,
      amountPaid: booking.amount_paid || booking.amount_charged,
    },
  );
  report.smsFunctionCalled = sms?.functionCalled === true || sms != null;
  report.twilioSid = sms?.twilioSid || null;
  report.sendSkipped = sms?.skipped ? sms.reason : null;
  report.twilioError = sms?.ok === false ? sms.error || sms.reason : sms?.skipped && sms.reason !== "idempotent_duplicate" ? sms.reason : null;

  if (sms?.twilioSid) {
    const delivery = await pollDelivery(sms.twilioSid);
    report.twilioSid = delivery?.sid || sms.twilioSid;
    report.twilioDeliveryStatus = delivery?.status || sms.status || null;
    if (delivery?.errorCode || delivery?.errorMessage || delivery?.fetchError) {
      report.twilioError = [delivery.errorCode, delivery.errorMessage || delivery.fetchError].filter(Boolean).join(" ");
    }
  } else {
    report.twilioDeliveryStatus = sms?.status || (sms?.skipped ? sms.reason : null);
  }

  console.log(JSON.stringify(report, null, 2));
  const ok =
    report.paypalCaptureSucceeded &&
    report.smsFunctionCalled &&
    Boolean(report.twilioSid) &&
    !["failed", "undelivered"].includes(String(report.twilioDeliveryStatus || "").toLowerCase());
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.error("[verify-sms] EXCEPTION", e?.message || e);
  console.log(JSON.stringify({ ...report, twilioError: e?.message || String(e) }, null, 2));
  process.exit(1);
}
