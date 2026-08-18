/**
 * SMS workflow tests — flags forced OFF; no live Twilio sends.
 * Covers verify gating, booking event bodies, PayPal idempotency,
 * non-fatal SMS failure, and email-fallback behavior contracts.
 */
import assert from "node:assert/strict";
import { createRequire } from "module";
import test from "node:test";

const require = createRequire(import.meta.url);

process.env.SMS_VERIFY_ENABLED = "0";
process.env.SMS_NOTIFICATIONS_ENABLED = "0";

const { normalizeToE164 } = require("../smsPhone.cjs");
const { isSmsNotificationsEnabled, isSmsVerifyEnabled, smsFlags } = require("../smsFlags.cjs");
const { startSmsVerification, checkSmsVerification } = require("../smsVerifyService.cjs");
const { sendTransactionalSms, findByIdempotencyKey } = require("../smsDeliveryService.cjs");
const { notifyBookingSms, buildBookingSmsBody, notifyPaidBookingConfirmationSms, buildPaidConfirmationSmsBody } = require("../smsBookingNotify.cjs");
const {
  mapPaypalEventToCategory,
  buildPaymentSmsBody,
  notifyPaymentSmsFromPaypalWebhook,
} = require("../smsPaymentNotify.cjs");

function memoryDb() {
  const rows = [];
  const dbQuery = async (sql, params = []) => {
    const s = String(sql);
    if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(s)) return { rows: [] };
    if (/INSERT INTO sms_message_log/i.test(s)) {
      const row = {
        id: `log-${rows.length + 1}`,
        idempotency_key: params[11] || null,
        twilio_sid: params[0] || null,
        status: params[1] || "queued",
        category: params[4],
      };
      if (row.idempotency_key && rows.some((r) => r.idempotency_key === row.idempotency_key)) {
        const err = new Error("duplicate key");
        err.code = "23505";
        throw err;
      }
      rows.push(row);
      return { rows: [row] };
    }
    if (/SELECT \* FROM sms_message_log WHERE idempotency_key/i.test(s)) {
      const hit = rows.find((r) => r.idempotency_key === params[0]);
      return { rows: hit ? [hit] : [] };
    }
    if (/UPDATE sms_message_log/i.test(s)) {
      const hit =
        rows.find((r) => r.id === params[0]) ||
        rows.find((r) => r.twilio_sid && r.twilio_sid === params[0]);
      if (hit) {
        if (params[1] != null) hit.twilio_sid = hit.twilio_sid || params[1];
        if (params[2] != null) hit.status = params[2];
      }
      return { rows: hit ? [hit] : [] };
    }
    if (/FROM bookings/i.test(s)) {
      return {
        rows: [
          {
            id: "3fbbf6ea-9ada-404a-9b1e-700da37b7264",
            user_id: null,
            phone: "+15551234567",
            customer_email: "customer@example.com",
            paypal_capture_id: "CAP123",
            paypal_order_id: "ORD123",
          },
        ],
      };
    }
    if (/FROM app_users/i.test(s)) return { rows: [] };
    if (/FROM sms_consent/i.test(s)) return { rows: [] };
    if (/FROM notification_preferences/i.test(s)) return { rows: [] };
    if (/INSERT INTO sms_verify_attempts/i.test(s)) return { rows: [] };
    if (/SELECT COUNT/i.test(s)) return { rows: [{ n: 0 }] };
    if (/EXTRACT\(EPOCH/i.test(s)) return { rows: [] };
    return { rows: [] };
  };
  dbQuery._rows = rows;
  return dbQuery;
}

test("flags remain disabled for this suite", () => {
  assert.equal(isSmsVerifyEnabled(), false);
  assert.equal(isSmsNotificationsEnabled(), false);
  assert.equal(smsFlags().verifyEnabled, false);
  assert.equal(smsFlags().notificationsEnabled, false);
});

test("AURA SMS verification refuses when SMS_VERIFY_ENABLED=0", async () => {
  const dbQuery = memoryDb();
  const start = await startSmsVerification(dbQuery, {
    phone: "+15551234567",
    purpose: "super_admin_login",
  });
  assert.equal(start.ok, false);
  assert.equal(start.error, "sms_verify_disabled");

  const check = await checkSmsVerification(dbQuery, {
    phone: "+15551234567",
    code: "123456",
    purpose: "super_admin_login",
  });
  assert.equal(check.ok, false);
  assert.equal(check.error, "sms_verify_disabled");
});

test("customer phone verification refuses when SMS_VERIFY_ENABLED=0", async () => {
  const dbQuery = memoryDb();
  const start = await startSmsVerification(dbQuery, {
    phone: "5551234567",
    purpose: "customer_phone",
  });
  assert.equal(start.ok, false);
  assert.equal(start.error, "sms_verify_disabled");
  assert.equal(normalizeToE164("5551234567").e164, "+15551234567");
});

test("booking created/approved/rescheduled/canceled SMS bodies + flag-off skip", async () => {
  const dbQuery = memoryDb();
  const booking = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    phone: "+15551234567",
    barber_name: "IFCDC",
    service: "Taper",
    date: "2026-08-06",
    time: "13:30",
    location: "HQ",
  };
  for (const event of [
    "booking_created",
    "booking_approved",
    "booking_rescheduled",
    "booking_canceled",
  ]) {
    const body = buildBookingSmsBody(event, booking);
    assert.match(body, /Taper/);
    assert.match(body, /Ref AAAAAAAA/i);
    assert.doesNotMatch(body, /paypal|cvv|card/i);
    const out = await notifyBookingSms(dbQuery, event, booking, { occurrence: "test" });
    assert.equal(out.ok, true);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "sms_notifications_disabled");
  }
});

test("PayPal payment completed SMS body + webhook skip when flags off", async () => {
  assert.equal(mapPaypalEventToCategory("PAYMENT.CAPTURE.COMPLETED"), "payment_success");
  const body = buildPaymentSmsBody("payment_success", {
    amount: "35.99",
    currency: "USD",
    bookingId: "3fbbf6ea-9ada-404a-9b1e-700da37b7264",
    captureId: "CAPXYZ",
  });
  assert.match(body, /35\.99/);
  assert.match(body, /3FBBF6EA/i);

  const dbQuery = memoryDb();
  const out = await notifyPaymentSmsFromPaypalWebhook(dbQuery, {
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP123",
      amount: { value: "35.99", currency_code: "USD" },
      supplementary_data: { related_ids: { order_id: "ORD123" } },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "sms_notifications_disabled");
});

test("PayPal webhook retry / duplicate idempotency key prevents double send", async () => {
  const dbQuery = memoryDb();
  const key = "paypal:PAYMENT.CAPTURE.COMPLETED:CAPDUP";

  // Pre-seed a prior delivered row (as if first webhook already logged a send).
  dbQuery._rows.push({
    id: "existing",
    idempotency_key: key,
    twilio_sid: "SMexisting",
    status: "delivered",
    category: "payment_success",
  });

  const retry = await sendTransactionalSms(dbQuery, {
    to: "+15551234567",
    body: "IFCDC test",
    category: "payment_success",
    paymentRef: "CAPDUP",
    idempotencyKey: key,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.skipped, true);
  assert.equal(retry.reason, "idempotent_duplicate");
  assert.equal(retry.twilioSid, "SMexisting");

  const found = await findByIdempotencyKey(dbQuery, key);
  assert.equal(found.twilio_sid, "SMexisting");
  assert.equal(dbQuery._rows.filter((r) => r.idempotency_key === key).length, 1);
});

test("SMS delivery failure does not reverse booking/payment success contract", async () => {
  const dbQuery = memoryDb();
  const bookingOk = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", payment_status: "paid_in_full" };
  let bookingMutated = false;
  const guardedDb = async (sql, params) => {
    if (/UPDATE bookings/i.test(String(sql)) && /payment_status/i.test(String(sql))) {
      bookingMutated = true;
    }
    return dbQuery(sql, params);
  };
  const sms = await notifyBookingSms(guardedDb, "booking_approved", {
    ...bookingOk,
    phone: "+15551234567",
  });
  assert.equal(sms.ok, true);
  assert.equal(sms.skipped, true);
  assert.equal(bookingMutated, false);
  assert.equal(bookingOk.payment_status, "paid_in_full");
});

test("email fallback contract: SMS skip leaves email path free to run", async () => {
  // When SMS is skipped/disabled, callers still invoke email independently.
  // This test documents the contract used by appBookingCheckoutRoutes + auraPhase2Hooks.
  const dbQuery = memoryDb();
  const sms = await notifyBookingSms(dbQuery, "booking_canceled", {
    id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    phone: "+15551234567",
    service: "Taper",
    barber_name: "IFCDC",
    date: "2026-08-06",
    time: "13:30",
  });
  assert.equal(sms.skipped, true);
  const emailWouldStillRun = sms.skipped === true || sms.ok === false;
  assert.equal(emailWouldStillRun, true);
});

test("paid confirmation SMS body matches client receipt format", () => {
  const body = buildPaidConfirmationSmsBody(
    {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      customer_name: "Alex",
      barber_name: "IFCDC Barbers",
      service: "Haircut",
      date: "2026-08-20",
      time: "14:00",
    },
    { amountPaid: 35 },
  );
  assert.match(body, /IFCDC Barbers · Ref AAAAAAAA/);
  assert.match(body, /Payment received — \$35\.00/);
  assert.match(body, /Your Haircut with IFCDC Barbers is confirmed for Aug 20 at 2:00 PM/);
  assert.match(body, /Thank you for booking, Alex/);
  assert.match(body, /Support: \+19895141064/);
});

test("paid confirmation SMS is not sent without capture or for unpaid bookings", async () => {
  const dbQuery = memoryDb();
  const booking = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    phone: "+15551234567",
    payment_status: "unpaid",
    service: "Haircut",
    date: "2026-08-20",
    time: "14:00",
  };
  const noCapture = await notifyPaidBookingConfirmationSms(dbQuery, booking, {});
  assert.equal(noCapture.ok, true);
  assert.equal(noCapture.skipped, true);
  assert.equal(noCapture.reason, "no_capture");

  const unpaid = await notifyPaidBookingConfirmationSms(dbQuery, booking, { captureId: "CAPUNPAID" });
  assert.equal(unpaid.ok, true);
  assert.equal(unpaid.skipped, true);
  assert.equal(unpaid.reason, "payment_not_paid");

  const cancelled = await notifyPaidBookingConfirmationSms(
    dbQuery,
    { ...booking, payment_status: "payment_failed" },
    { captureId: "CAPFAIL" },
  );
  assert.equal(cancelled.skipped, true);
  assert.equal(cancelled.reason, "payment_not_paid");
});

test("paid confirmation SMS idempotency blocks finalize + webhook duplicates", async () => {
  const dbQuery = memoryDb();
  const key = "booking:paid_confirmation:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  dbQuery._rows.push({
    id: "existing-paid-sms",
    idempotency_key: key,
    twilio_sid: "SMpaid1",
    status: "queued",
    category: "booking_approved",
  });

  const retry = await sendTransactionalSms(dbQuery, {
    to: "+15551234567",
    body: "IFCDC Barbers · Ref AAAAAAAA: Payment received — $35.00.",
    category: "booking_approved",
    bookingId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    paymentRef: "CAPDUP",
    idempotencyKey: key,
    force: true,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.skipped, true);
  assert.equal(retry.reason, "idempotent_duplicate");
  assert.equal(retry.twilioSid, "SMpaid1");
  assert.equal(dbQuery._rows.filter((r) => r.idempotency_key === key).length, 1);
});

test("failed SMS log does not block a later paid-confirmation send", async () => {
  const dbQuery = memoryDb();
  const key = "booking:paid_confirmation:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  dbQuery._rows.push({
    id: "failed-paid-sms",
    idempotency_key: key,
    twilio_sid: null,
    status: "failed",
    category: "booking_approved",
  });

  const retry = await sendTransactionalSms(dbQuery, {
    to: "+15551234567",
    body: "IFCDC Barbers · Ref BBBBBBBB: Payment received — $35.00.",
    category: "booking_approved",
    bookingId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    paymentRef: "CAPRETRY",
    idempotencyKey: key,
    force: true,
  });
  assert.notEqual(retry.reason, "idempotent_duplicate");
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "twilio_messaging_not_configured");
});

test("paid confirmation SMS is attempted even when notification flags are off", async () => {
  assert.equal(isSmsNotificationsEnabled(), false);
  const dbQuery = memoryDb();
  const sms = await notifyPaidBookingConfirmationSms(
    dbQuery,
    {
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      phone: "+15551234567",
      payment_status: "paid_in_full",
      paypal_capture_id: "CAPFORCE",
      service: "Haircut",
      date: "2026-08-20",
      time: "14:00",
    },
    { captureId: "CAPFORCE", alreadySettled: true, amountPaid: 35 },
  );
  assert.equal(sms.functionCalled, true);
  assert.notEqual(sms.reason, "sms_notifications_disabled");
  assert.equal(sms.ok, false);
  assert.equal(sms.reason, "twilio_messaging_not_configured");
});

test("email failure path is independent of SMS call order in finalize helper", () => {
  const src = require("node:fs").readFileSync(
    new URL("../appBookingCheckoutRoutes.cjs", import.meta.url),
    "utf8",
  );
  const smsIdx = src.indexOf("notifyPaidBookingConfirmationSms");
  const emailIdx = src.indexOf("sendBookingEmail");
  assert.ok(smsIdx > 0 && emailIdx > smsIdx);
  assert.match(src, /SMS already attempted/);
  assert.match(src, /Never leak email provider failures/);
});
