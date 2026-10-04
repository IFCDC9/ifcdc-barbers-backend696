/**
 * Booking email delivery. No network and no live mail.
 * Fixture credentials exist only inside this process.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authorizeOutboundEmail } from "../emailSecurityGate.cjs";
import { createSqlLedger, deliverTransactionalEmail } from "../emailDelivery.cjs";
import {
  sendBookingCancellationEmail,
  sendBookingEmail,
  sendBookingRescheduleEmail,
} from "../bookingEmail.cjs";
import { sendPaymentSuccessEmails } from "../paypalWebhookEmail.cjs";

function createDurableDb() {
  const table = new Map();
  async function dbQuery(sql, params = []) {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO email_delivery_claims/i.test(sql)) {
      const [key, templateId] = params;
      if (table.has(key)) return { rows: [] };
      table.set(key, { status: "in_flight", template_id: templateId, provider: null, message_id: null });
      return { rows: [{ status: "in_flight" }] };
    }
    if (/status = 'failed'/i.test(sql)) {
      const [key, templateId] = params;
      const row = table.get(key);
      if (row?.status === "failed") {
        row.status = "in_flight";
        row.template_id = templateId;
        return { rows: [{ status: "in_flight" }] };
      }
      return { rows: [] };
    }
    if (/UPDATE email_delivery_claims/i.test(sql)) {
      const [status, provider, messageId, key] = params;
      const row = table.get(key);
      if (row) {
        row.status = status;
        row.provider = provider;
        row.message_id = messageId;
      }
      return { rows: [] };
    }
    if (/SELECT status FROM email_delivery_claims/i.test(sql)) {
      const row = table.get(params[0]);
      return { rows: row ? [{ status: row.status }] : [] };
    }
    throw new Error("unexpected sql");
  }
  return { dbQuery, table };
}

function postmarkFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      async json() {
        return { ErrorCode: 0, MessageID: "pm-msg" };
      },
    };
  };
}

test("confirmation, reschedule, and cancellation use distinct templates and Postmark first", async () => {
  const token = randomBytes(16).toString("hex");
  const previous = process.env.POSTMARK_SERVER_TOKEN;
  const previousFrom = process.env.MAIL_FROM;
  process.env.POSTMARK_SERVER_TOKEN = token;
  process.env.MAIL_FROM = "IFCDC Barbers <service@ifcdcbarbersapp.com>";
  process.env.BOOKING_ADMIN_EMAIL = "ava@example.com";
  const { dbQuery } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  const calls = [];
  const deps = { ledger, fetchImpl: postmarkFetch(calls) };
  let resendCalls = 0;
  deps.sendResend = async () => {
    resendCalls += 1;
    return { success: true, provider: "resend", messageId: "re-msg" };
  };

  try {
    const confirmation = await sendBookingEmail({
      bookingId: "book-1",
      name: "Ava",
      email: "ava@example.com",
      service: "Haircut",
      date: "2026-10-06",
      time: "10:00 AM",
      paymentStatus: "paid_in_full",
      captureId: "CAP-1",
      alsoSendPaymentConfirmation: true,
      deps,
    });
    const reschedule = await sendBookingRescheduleEmail({
      bookingId: "book-1",
      name: "Ava",
      email: "ava@example.com",
      service: "Haircut",
      date: "2026-10-07",
      time: "11:00 AM",
      previousDate: "2026-10-06",
      previousTime: "10:00 AM",
      deps,
    });
    const cancellation = await sendBookingCancellationEmail({
      bookingId: "book-1",
      name: "Ava",
      email: "ava@example.com",
      service: "Haircut",
      date: "2026-10-07",
      time: "11:00 AM",
      deps,
    });

    assert.equal(confirmation.provider, "postmark");
    assert.equal(confirmation.customerPaymentEmail, "suppressed");
    assert.equal(confirmation.paymentMessageId, null);
    assert.equal(reschedule.provider, "postmark");
    assert.equal(cancellation.provider, "postmark");
    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.url.includes("api.postmarkapp.com/email")), true);
    assert.equal(resendCalls, 0);
    const bodies = calls.map((call) => JSON.parse(call.init.body));
    assert.equal(bodies[0].Subject.includes("Booking"), true);
    assert.equal(bodies[1].Subject.toLowerCase().includes("rescheduled"), true);
    assert.equal(bodies[2].Subject.toLowerCase().includes("cancelled"), true);
    assert.equal(bodies.some((body) => /payment confirmation/i.test(body.Subject)), false);
    assert.equal(calls.every((call) => call.init.headers["X-Postmark-Server-Token"] === token), true);
    assert.equal(bodies.every((body) => body.From === "IFCDC Barbers <service@ifcdcbarbersapp.com>"), true);
  } finally {
    if (previous == null) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = previous;
    if (previousFrom == null) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previousFrom;
    delete process.env.BOOKING_ADMIN_EMAIL;
  }
});

test("the same booking confirmation is not sent twice", async () => {
  const token = randomBytes(16).toString("hex");
  const previousFrom = process.env.MAIL_FROM;
  process.env.POSTMARK_SERVER_TOKEN = token;
  process.env.MAIL_FROM = "IFCDC Barbers <service@ifcdcbarbersapp.com>";
  process.env.BOOKING_ADMIN_EMAIL = "ben@example.com";
  const { dbQuery } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  const calls = [];
  const deps = { ledger, fetchImpl: postmarkFetch(calls), sendResend: async () => ({ success: true, provider: "resend" }) };
  try {
    const first = await sendBookingEmail({
      bookingId: "book-2",
      name: "Ben",
      email: "ben@example.com",
      service: "Fade",
      date: "2026-10-06",
      time: "1:00 PM",
      paymentStatus: "paid_in_full",
      deps,
    });
    const second = await sendBookingEmail({
      bookingId: "book-2",
      name: "Ben",
      email: "ben@example.com",
      service: "Fade",
      date: "2026-10-06",
      time: "1:00 PM",
      paymentStatus: "paid_in_full",
      deps,
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(calls.length, 1);
  } finally {
    delete process.env.POSTMARK_SERVER_TOKEN;
    if (previousFrom == null) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previousFrom;
    delete process.env.BOOKING_ADMIN_EMAIL;
  }
});

test("an uncertain Postmark response does not fall back or send again", async () => {
  const token = randomBytes(16).toString("hex");
  process.env.POSTMARK_SERVER_TOKEN = token;
  const { dbQuery } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  let fetches = 0;
  let resendCalls = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error("socket hang up");
  };
  const sendResend = async () => {
    resendCalls += 1;
    return { success: true, provider: "resend" };
  };
  try {
    const first = await deliverTransactionalEmail({
      ledger,
      fetchImpl,
      sendResend,
      to: "cara@example.com",
      subject: "Booking Confirmation - IFCDC Barbers",
      html: "<p>Confirmed</p>",
      text: "Confirmed",
      templateId: "booking_confirmation",
      idempotencyKey: "booking:book-3:booking_confirmation",
    });
    const second = await deliverTransactionalEmail({
      ledger,
      fetchImpl,
      sendResend,
      to: "cara@example.com",
      subject: "Booking Confirmation - IFCDC Barbers",
      html: "<p>Confirmed</p>",
      text: "Confirmed",
      templateId: "booking_confirmation",
      idempotencyKey: "booking:book-3:booking_confirmation",
    });
    assert.equal(first.uncertain, true);
    assert.equal(first.fallbackUsed, false);
    assert.equal(second.duplicate, true);
    assert.equal(fetches, 1);
    assert.equal(resendCalls, 0);
  } finally {
    delete process.env.POSTMARK_SERVER_TOKEN;
  }
});

test("Resend is used only when Postmark is absent or rejects", async () => {
  const { dbQuery } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  delete process.env.POSTMARK_SERVER_TOKEN;
  let postmarkFetches = 0;
  let resendCalls = 0;
  const absent = await deliverTransactionalEmail({
    ledger,
    fetchImpl: async () => {
      postmarkFetches += 1;
      return { status: 200, async json() { return { ErrorCode: 0, MessageID: "x" }; } };
    },
    sendResend: async () => {
      resendCalls += 1;
      return { success: true, provider: "resend", messageId: "re-1" };
    },
    to: "drew@example.com",
    subject: "Appointment rescheduled — IFCDC Barbers",
    html: "<p>Rescheduled</p>",
    text: "Rescheduled",
    templateId: "booking_reschedule",
    idempotencyKey: "booking:book-4:booking_reschedule:2026-10-08:2:00 PM",
  });
  assert.equal(absent.provider, "resend");
  assert.equal(absent.fallbackUsed, true);
  assert.equal(postmarkFetches, 0);
  assert.equal(resendCalls, 1);

  const token = randomBytes(16).toString("hex");
  process.env.POSTMARK_SERVER_TOKEN = token;
  const rejected = await deliverTransactionalEmail({
    ledger,
    fetchImpl: async () => ({
      status: 422,
      async json() {
        return { ErrorCode: 300, Message: "rejected" };
      },
    }),
    sendResend: async () => {
      resendCalls += 1;
      return { success: true, provider: "resend", messageId: "re-2" };
    },
    to: "drew@example.com",
    subject: "Appointment cancelled — IFCDC Barbers",
    html: "<p>Cancelled</p>",
    text: "Cancelled",
    templateId: "booking_cancellation",
    idempotencyKey: "booking:book-4:booking_cancellation",
  });
  assert.equal(rejected.provider, "resend");
  assert.equal(resendCalls, 2);
  delete process.env.POSTMARK_SERVER_TOKEN;
});

test("webhook retry does not send a second customer payment email", async () => {
  const token = randomBytes(16).toString("hex");
  const previousFrom = process.env.MAIL_FROM;
  process.env.POSTMARK_SERVER_TOKEN = token;
  process.env.MAIL_FROM = "IFCDC Barbers <service@ifcdcbarbersapp.com>";
  process.env.BOOKING_ADMIN_EMAIL = "ops@example.com";
  const { dbQuery } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  const calls = [];
  const deps = { ledger, fetchImpl: postmarkFetch(calls), sendResend: async () => ({ success: true, provider: "resend" }) };
  try {
    await sendPaymentSuccessEmails({
      captureId: "CAP-9",
      orderId: "ORD-9",
      amount: "40.00",
      currency: "USD",
      payerEmail: "payer@example.com",
      payerName: "Payer",
      deps,
    });
    await sendPaymentSuccessEmails({
      captureId: "CAP-9",
      orderId: "ORD-9",
      amount: "40.00",
      currency: "USD",
      payerEmail: "payer@example.com",
      payerName: "Payer",
      deps,
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.To, "ops@example.com");
    assert.equal(body.To.includes("payer@example.com"), false);
    assert.equal(/payment received/i.test(body.Subject), true);
  } finally {
    delete process.env.POSTMARK_SERVER_TOKEN;
    if (previousFrom == null) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previousFrom;
    delete process.env.BOOKING_ADMIN_EMAIL;
  }
});

test("a failed claim can be retried and sent or uncertain stay blocked", async () => {
  const token = randomBytes(16).toString("hex");
  const previous = process.env.POSTMARK_SERVER_TOKEN;
  process.env.POSTMARK_SERVER_TOKEN = token;
  const { dbQuery, table } = createDurableDb();
  const ledger = createSqlLedger(dbQuery);
  let mode = "reject";
  const fetchImpl = async () => {
    if (mode === "uncertain") {
      return { status: 503, async json() { return {}; } };
    }
    if (mode === "ok") {
      return { status: 200, async json() { return { ErrorCode: 0, MessageID: "pm-retry" }; } };
    }
    return { status: 422, async json() { return { ErrorCode: 300, Message: "rejected" }; } };
  };
  const sendResend = async () => ({
    configured: true,
    success: false,
    uncertain: false,
    error: "resend_rejected",
  });
  const message = {
    ledger,
    fetchImpl,
    sendResend,
    to: "frank@example.com",
    subject: "Booking Confirmation - IFCDC Barbers",
    html: "<p>Confirmed</p>",
    text: "Confirmed",
    templateId: "booking_confirmation",
  };
  try {
    const failed = await deliverTransactionalEmail({
      ...message,
      idempotencyKey: "booking:book-fail:booking_confirmation",
    });
    assert.equal(failed.success, false);
    assert.equal(table.get("booking:book-fail:booking_confirmation").status, "failed");

    mode = "ok";
    const retried = await deliverTransactionalEmail({
      ...message,
      idempotencyKey: "booking:book-fail:booking_confirmation",
    });
    assert.equal(retried.success, true);
    assert.equal(retried.duplicate, false);
    assert.equal(retried.provider, "postmark");
    assert.equal(table.get("booking:book-fail:booking_confirmation").status, "sent");

    const sentAgain = await deliverTransactionalEmail({
      ...message,
      idempotencyKey: "booking:book-fail:booking_confirmation",
    });
    assert.equal(sentAgain.duplicate, true);
    assert.equal(sentAgain.status, "sent");

    mode = "uncertain";
    const uncertain = await deliverTransactionalEmail({
      ...message,
      idempotencyKey: "booking:book-uncertain:booking_confirmation",
    });
    assert.equal(uncertain.uncertain, true);
    assert.equal(uncertain.fallbackUsed, false);
    const uncertainAgain = await deliverTransactionalEmail({
      ...message,
      idempotencyKey: "booking:book-uncertain:booking_confirmation",
    });
    assert.equal(uncertainAgain.duplicate, true);
    assert.equal(uncertainAgain.status, "uncertain");
    assert.equal(table.get("booking:book-uncertain:booking_confirmation").status, "uncertain");
  } finally {
    if (previous == null) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = previous;
  }
});

test("gate allows password reset, reminder, and payment receipt", () => {
  const reset = authorizeOutboundEmail({
    to: "erin@example.com",
    subject: "Reset Your Password",
    html: "<p>Reset password</p>",
    templateId: "password_reset",
    label: "auth-reset-password",
  });
  const reminder = authorizeOutboundEmail({
    to: "erin@example.com",
    subject: "Reminder — appointment in ~30 minutes",
    html: "<p>Reminder for your appointment</p>",
    templateId: "appointment_reminder",
    label: "booking-reminder",
  });
  const receipt = authorizeOutboundEmail({
    to: "erin@example.com",
    subject: "[IFCDC] Refund processed — $10.00",
    html: "<p>Refund confirmation</p>",
    templateId: "payment_receipt",
    label: "booking-refund-customer",
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.templateId, "password_reset");
  assert.equal(reminder.ok, true);
  assert.equal(reminder.templateId, "appointment_reminder");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.templateId, "payment_receipt");
});
