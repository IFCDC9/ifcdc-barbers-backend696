/**
 * Phase 3B Postmark standardization. Fixture tokens only.
 * Does not call reminder scanners, the daily report, HubSpot, or a live provider.
 */
process.env.NODE_ENV = "test";
process.env.EMAIL_RATE_LIMIT_PER_MIN = "80";
process.env.EMAIL_RATE_LIMIT_GLOBAL_PER_MIN = "800";
process.env.POSTMARK_SERVER_TOKEN = "fixture-postmark-token";
process.env.BOOKING_ADMIN_EMAIL = "phase3b-admin@fixture.test";
process.env.REVIEW_ADMIN_EMAIL = "phase3b-reviews@fixture.test";
process.env.AURA_DAILY_REPORT_TO = "phase3b-admin@fixture.test";
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_RECIPIENT_ALLOWLIST;
delete process.env.AURA_WAITLIST_NOTIFY_ALLOWLIST;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const { createSqlLedger } = require("../emailDelivery.cjs");
const { APPROVED_TEMPLATE_IDS } = require("../emailSecurityGate.cjs");
const { sendAuraReminderEmail, sendAuraCancelEmail, sendAuraRescheduleEmail, sendAuraBarberEventEmail, sendAuraAdminFailureAlert, sendAuraReviewFollowupEmail } = require("../auraPhase2Emails.cjs");
const { deliverLegacyAppointmentReminder } = await import("../bookingReminders.js");
const { sendAuraVoiceBookingEmail, sendBookingRefundEmail } = require("../bookingEmail.cjs");
const { deliverFounderOperationalEmail } = require("../auraFounderNotify.cjs");
const { deliverFounderDailyReportEmail } = require("../auraDailyReport.cjs");
const { sendOrphanedPaymentAdminAlert } = require("../orphanedPaymentAlert.cjs");
const { emailBarberNewReview, emailCustomerReviewPrompt, emailAdminReviewModeration } = require("../reviewNotificationEmail.cjs");
const { emailSuperAdminNewSignupPending, emailUserAccountApproved, emailUserAccountDenied } = await import("../approvalEmailService.js");
const { sendWaitlistOfferEmail } = require("../auraWaitlistEmails.cjs");
const { deliverOperationalDigestEmail } = require("../auraOperationalInsightsService.cjs");
const { sendViaResend } = await import("../hubspotStarterAutomationService.js");
const { deliverCustomerPasswordResetEmail } = await import("../passwordResetService.js");
const { deliverAdminPasswordResetEmail } = await import("../adminPasswordResetRoutes.js");
const { refuseDiagnosticTestEmail } = require("../testEmailRoute.cjs");
const { mapEmailClaim } = await import("../hqNotificationActivity.js");

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async dbQuery(sql, params = []) {
      const text = String(sql);
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("INSERT")) {
        const [key, templateId] = params;
        if (rows.has(key)) return { rows: [] };
        rows.set(key, { template_id: templateId, status: "in_flight", provider: null, message_id: null });
        return { rows: [{ status: "in_flight" }] };
      }
      if (text.includes("SELECT status")) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ status: row.status }] : [] };
      }
      if (text.includes("status = 'failed'")) {
        const row = rows.get(params[0]);
        if (row?.status === "failed") {
          row.status = "in_flight";
          row.template_id = params[1];
          row.provider = null;
          row.message_id = null;
          return { rows: [{ status: "in_flight" }] };
        }
        return { rows: [] };
      }
      if (text.includes("UPDATE")) {
        const [status, provider, messageId, key] = params;
        const row = rows.get(key);
        if (!row) throw new Error("mark without claim");
        row.status = status;
        row.provider = provider;
        row.message_id = messageId;
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${text.slice(0, 80)}`);
    },
  };
}

function harness(mode, expectedKey) {
  const db = memoryDb();
  const ledger = createSqlLedger(db.dbQuery);
  const fetches = [];
  const resends = [];
  const fetchImpl = async () => {
    fetches.push(mode);
    if (fetches.length === 1 && expectedKey) {
      assert.equal(db.rows.get(expectedKey)?.status, "in_flight");
    }
    if (mode === "throw") throw new Error("timeout");
    if (mode === "reject") {
      return { status: 422, json: async () => ({ ErrorCode: 406, Message: "rejected" }) };
    }
    if (mode === "uncertain") return { status: 503, json: async () => ({}) };
    return { status: 200, json: async () => ({ ErrorCode: 0, MessageID: "pm-fixture" }) };
  };
  const sendResend = async () => {
    resends.push("resend");
    return { success: true, provider: "resend", messageId: "re-fixture" };
  };
  return { db, ledger, fetches, resends, deps: { ledger, fetchImpl, sendResend } };
}

function assertAcceptedNotDelivered(row) {
  assert.equal(row.status, "sent");
  assert.notEqual(row.status, "delivered");
  assert.equal(row.provider, "postmark");
  assert.equal(row.message_id, "pm-fixture");
  const mapped = mapEmailClaim({
    template_id: row.template_id,
    status: row.status,
    provider: row.provider,
    message_id: row.message_id,
    idempotency_key: "booking:book-1:appointment_reminder:24h",
  });
  assert.equal(mapped.status, "accepted");
  assert.notEqual(mapped.status, "delivered");
}

async function proveFallback(send, key) {
  const rejected = harness("reject", key);
  await send(rejected.deps);
  assert.ok(rejected.resends.length >= 1);
  assert.equal(rejected.db.rows.get(key)?.status, "sent");
  assert.equal(rejected.db.rows.get(key)?.provider, "resend");

  const uncertain = harness("uncertain", key);
  await send(uncertain.deps);
  assert.equal(uncertain.resends.length, 0);
  assert.equal(uncertain.db.rows.get(key)?.status, "uncertain");

  const thrown = harness("throw", key);
  await send(thrown.deps);
  assert.equal(thrown.resends.length, 0);
  assert.equal(thrown.db.rows.get(key)?.status, "uncertain");
}

test("locale subject families stay specific", () => {
  const reminder = APPROVED_TEMPLATE_IDS.appointment_reminder.subjectAllow;
  const receipt = APPROVED_TEMPLATE_IDS.payment_receipt.subjectAllow;
  assert.equal(reminder.some((re) => re.test("Recordatorio — cita en ~30 minutos")), true);
  assert.equal(reminder.some((re) => re.test("Rappel — rendez-vous dans ~30 minutes")), true);
  assert.equal(receipt.some((re) => re.test("[IFCDC] Reembolso procesado — $10.00")), true);
  assert.equal(APPROVED_TEMPLATE_IDS.appointment_reminder.subjectAllow.some((re) => re.source === ".*"), false);
});

test("appointment reminders claim per booking and window", async () => {
  const key24 = "booking:book-24:appointment_reminder:24h";
  const ok = harness("accept", key24);
  const sent = await sendAuraReminderEmail({
    customerEmail: "reminder-24@fixture.test",
    customerName: "Fixture",
    bookingId: "book-24",
    deps: ok.deps,
  }, "24h");
  assert.equal(sent.ok, true);
  assert.equal(ok.db.rows.get(key24).template_id, "appointment_reminder");
  assertAcceptedNotDelivered(ok.db.rows.get(key24));
  const again = await sendAuraReminderEmail({
    customerEmail: "reminder-24@fixture.test",
    customerName: "Fixture",
    bookingId: "book-24",
    deps: ok.deps,
  }, "24h");
  assert.equal(again.duplicate, true);
  assert.equal(ok.fetches.length, 1);
  await proveFallback((deps) => sendAuraReminderEmail({
    customerEmail: "reminder-24b@fixture.test",
    bookingId: "book-24",
    deps,
  }, "24h"), key24);

  for (const window of ["2h", "30m"]) {
    const key = `booking:book-${window}:appointment_reminder:${window}`;
    const box = harness("accept", key);
    const out = await sendAuraReminderEmail({
      customerEmail: `reminder-${window}@fixture.test`,
      bookingId: `book-${window}`,
      deps: box.deps,
    }, window);
    assert.equal(out.ok, true);
    assert.equal(box.db.rows.get(key).template_id, "appointment_reminder");
    assert.equal(box.db.rows.get(key).status, "sent");
  }

  const legacyKey = "booking:book-legacy:appointment_reminder:30m";
  const legacy = harness("accept", legacyKey);
  const legacySent = await deliverLegacyAppointmentReminder({
    to: "reminder-legacy@fixture.test",
    subject: "Reminder — appointment in ~30 minutes",
    html: "<p>Reminder</p>",
    text: "Reminder",
    bookingId: "book-legacy",
    deps: legacy.deps,
  });
  assert.equal(legacySent.success, true);
  assert.equal(legacy.db.rows.get(legacyKey).template_id, "appointment_reminder");
  assertAcceptedNotDelivered(legacy.db.rows.get(legacyKey));
  const mapped = mapEmailClaim({
    template_id: "appointment_reminder",
    status: "sent",
    provider: "postmark",
    message_id: "pm-fixture",
    idempotency_key: legacyKey,
  });
  assert.equal(mapped.bookingId, "book-legacy");
  assert.equal(mapped.reminderWindow, "30m");
  assert.equal(mapped.relationship, "customer");
});

test("extra AURA reschedule and cancellation copies do not send", async () => {
  const hooks = readFileSync(`${root}auraPhase2Hooks.cjs`, "utf8");
  assert.equal(hooks.includes("sendAuraCancelEmail("), false);
  assert.equal(hooks.includes("sendAuraRescheduleEmail("), false);
  const box = harness("accept");
  const cancel = await sendAuraCancelEmail({ customerEmail: "cancel@fixture.test", bookingId: "book-c", deps: box.deps });
  const reschedule = await sendAuraRescheduleEmail({ customerEmail: "move@fixture.test", bookingId: "book-r", deps: box.deps });
  assert.equal(cancel.sent, false);
  assert.equal(cancel.retired, true);
  assert.equal(reschedule.sent, false);
  assert.equal(reschedule.retired, true);
  assert.equal(box.fetches.length, 0);
  assert.equal(box.resends.length, 0);
  assert.equal(box.db.rows.size, 0);
});

test("barber booking event writes a barber claim", async () => {
  const key = "booking:book-barber:barber_notification:created";
  const box = harness("accept", key);
  const sent = await sendAuraBarberEventEmail({
    barberEmail: "barber-event@fixture.test",
    customerName: "Fixture",
    bookingId: "book-barber",
    deps: box.deps,
  }, "created");
  assert.equal(sent.ok, true);
  assert.equal(box.db.rows.get(key).template_id, "barber_notification");
  assertAcceptedNotDelivered(box.db.rows.get(key));
  const mapped = mapEmailClaim({ template_id: "barber_notification", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: key });
  assert.equal(mapped.relationship, "barber");
  assert.equal(mapped.bookingId, "book-barber");
  await proveFallback((deps) => sendAuraBarberEventEmail({
    barberEmail: "barber-event-b@fixture.test",
    bookingId: "book-barber",
    deps,
  }, "created"), key);
});

test("admin failure, review follow-up, founder event, and daily report sender", async () => {
  const adminKey = "booking:book-admin:admin_notice:reminder_24h_failed";
  const admin = harness("accept", adminKey);
  const adminSent = await sendAuraAdminFailureAlert({
    kind: "reminder_24h_failed",
    detail: { bookingId: "book-admin" },
    deps: admin.deps,
  });
  assert.equal(adminSent.ok, true);
  assert.equal(admin.db.rows.get(adminKey).template_id, "admin_notice");
  assertAcceptedNotDelivered(admin.db.rows.get(adminKey));
  await proveFallback((deps) => sendAuraAdminFailureAlert({
    kind: "reminder_24h_failed",
    detail: { bookingId: "book-admin" },
    deps,
  }), adminKey);

  const reviewKey = "booking:book-follow:review_followup";
  const review = harness("accept", reviewKey);
  const reviewSent = await sendAuraReviewFollowupEmail({
    customerEmail: "follow@fixture.test",
    customerName: "Fixture",
    bookingId: "book-follow",
    deps: review.deps,
  });
  assert.equal(reviewSent.ok, true);
  assert.equal(review.db.rows.get(reviewKey).template_id, "review_followup");
  assertAcceptedNotDelivered(review.db.rows.get(reviewKey));

  const founderKey = "founder:evt-1:founder_notice";
  const founder = harness("accept", founderKey);
  const founderSent = await deliverFounderOperationalEmail({
    to: "founder-event@fixture.test",
    title: "AURA: booking created",
    body: "fixture",
    event: { id: "evt-1", event_type: "booking_created" },
    deps: founder.deps,
  });
  assert.equal(founderSent.success, true);
  assert.equal(founder.db.rows.get(founderKey).template_id, "founder_notice");
  assertAcceptedNotDelivered(founder.db.rows.get(founderKey));

  const reportKey = "founder:daily_report:2026-10-06";
  const report = harness("accept", reportKey);
  const reportSent = await deliverFounderDailyReportEmail({
    to: "founder-report@fixture.test",
    day: "2026-10-06",
    html: "<p>IFCDC daily report</p>",
    text: "IFCDC daily report",
    deps: report.deps,
  });
  assert.equal(reportSent.success, true);
  assert.equal(report.db.rows.get(reportKey).template_id, "founder_daily_report");
  assertAcceptedNotDelivered(report.db.rows.get(reportKey));
  const mapped = mapEmailClaim({ template_id: "founder_daily_report", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: reportKey });
  assert.equal(mapped.relationship, "founder");
});

test("password reset claims account security without sending a live reset", async () => {
  const customerKey = "account:user-1:password_reset:0123456789abcdef";
  const customer = harness("accept", customerKey);
  const sent = await deliverCustomerPasswordResetEmail({
    to: "reset-customer@fixture.test",
    html: "<p>Reset your password</p>",
    userId: "user-1",
    tokenHash: "0123456789abcdefEXTRA",
    deps: customer.deps,
  });
  assert.equal(sent.success, true);
  assert.equal(sent.delivered, false);
  assert.equal(customer.db.rows.get(customerKey).template_id, "password_reset");
  assertAcceptedNotDelivered(customer.db.rows.get(customerKey));
  const mapped = mapEmailClaim({ template_id: "password_reset", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: customerKey });
  assert.equal(mapped.relationship, "account_security");
  assert.equal(mapped.bookingId, null);
  await proveFallback((deps) => deliverCustomerPasswordResetEmail({
    to: "reset-customer-b@fixture.test",
    html: "<p>Reset</p>",
    userId: "user-1",
    tokenHash: "0123456789abcdefEXTRA",
    deps,
  }), customerKey);

  const adminKey = "account:admin-user-1:password_reset:fedcba9876543210";
  const admin = harness("accept", adminKey);
  const adminSent = await deliverAdminPasswordResetEmail({
    to: "reset-admin@fixture.test",
    html: "<p>IFCDC password reset</p>",
    userId: "admin-user-1",
    tokenHash: "fedcba9876543210EXTRA",
    deps: admin.deps,
  });
  assert.equal(adminSent.success, true);
  assert.equal(admin.db.rows.get(adminKey).template_id, "password_reset");
  assert.equal(adminSent.delivered, false);
});

test("voice confirmation shares the booking confirmation claim", async () => {
  const key = "booking:book-voice:booking_confirmation";
  const box = harness("accept", key);
  const sent = await sendAuraVoiceBookingEmail({
    email: "voice@fixture.test",
    name: "Fixture",
    date: "2026-10-07",
    time: "10:00",
    bookingId: "book-voice",
    deps: box.deps,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.delivered, undefined);
  assert.equal(box.db.rows.get(key).template_id, "booking_confirmation");
  assert.equal(box.db.rows.get(`${key}:admin`).template_id, "admin_notice");
  assertAcceptedNotDelivered(box.db.rows.get(key));
  const again = await sendAuraVoiceBookingEmail({
    email: "voice@fixture.test",
    name: "Fixture",
    date: "2026-10-07",
    time: "10:00",
    bookingId: "book-voice",
    deps: box.deps,
  });
  assert.equal(again.customer.duplicate, true);
  assert.equal(box.fetches.length, 2);
  await proveFallback((deps) => sendAuraVoiceBookingEmail({
    email: "voice-b@fixture.test",
    name: "Fixture",
    date: "2026-10-07",
    time: "10:00",
    bookingId: "book-voice",
    deps,
  }), key);
});

test("refund, orphaned payment, reviews, account notices, waitlist, digest, and starter fallback", async () => {
  const receiptKey = "booking:book-rf:payment_receipt:rf-1";
  const refund = harness("accept", receiptKey);
  const refundSent = await sendBookingRefundEmail({
    email: "refund@fixture.test",
    name: "Fixture",
    service: "Haircut",
    date: "2026-10-07",
    time: "11:00",
    refundAmount: 12,
    refundId: "rf-1",
    bookingId: "book-rf",
    language: "en",
    deps: refund.deps,
  });
  assert.equal(refundSent.success, true);
  assert.equal(refund.db.rows.get(receiptKey).template_id, "payment_receipt");
  assert.equal(refund.db.rows.get("booking:book-rf:admin_notice:refund:rf-1").template_id, "admin_notice");
  assertAcceptedNotDelivered(refund.db.rows.get(receiptKey));
  await proveFallback((deps) => sendBookingRefundEmail({
    email: "refund-b@fixture.test",
    name: "Fixture",
    refundAmount: 12,
    refundId: "rf-1",
    bookingId: "book-rf",
    language: "en",
    deps,
  }), receiptKey);

  const orphanKey = "booking:book-or:admin_notice:orphaned_payment";
  const orphan = harness("accept", orphanKey);
  const orphanSent = await sendOrphanedPaymentAdminAlert({
    bookingId: "book-or",
    captureId: "cap-1",
    reason: "missing_booking",
    deps: orphan.deps,
  });
  assert.equal(orphanSent.ok, true);
  assert.equal(orphan.db.rows.get(orphanKey).template_id, "admin_notice");
  assertAcceptedNotDelivered(orphan.db.rows.get(orphanKey));

  const barberReviewKey = "review:rev-1:barber_review:barber-review@fixture.test";
  const barberReview = harness("accept", barberReviewKey);
  const reviewToBarber = await emailBarberNewReview({
    dbQuery: async (sql) => {
      if (String(sql).includes("FROM barbers")) return { rows: [{ name: "Fixture", owner_email: "barber-review@fixture.test" }] };
      return { rows: [] };
    },
    barberId: "barber-1",
    reviewId: "rev-1",
    rating: 5,
    comment: "Fixture",
    customerName: "Fixture",
    deps: barberReview.deps,
  });
  assert.equal(reviewToBarber.ok, true);
  assert.equal(barberReview.db.rows.get(barberReviewKey).template_id, "barber_review");
  const barberMapped = mapEmailClaim({ template_id: "barber_review", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: barberReviewKey });
  assert.equal(barberMapped.relationship, "barber");

  const promptKey = "booking:book-prompt:review_prompt";
  const prompt = harness("accept", promptKey);
  const promptSent = await emailCustomerReviewPrompt({
    to: "prompt@fixture.test",
    customerName: "Fixture",
    barberName: "Fixture",
    bookingId: "book-prompt",
    language: "en",
    deps: prompt.deps,
  });
  assert.equal(promptSent.success, true);
  assert.equal(prompt.db.rows.get(promptKey).template_id, "review_prompt");
  assertAcceptedNotDelivered(prompt.db.rows.get(promptKey));

  const moderationKey = "booking:book-mod:admin_notice:moderation:rev-mod";
  const moderation = harness("accept", moderationKey);
  const moderationSent = await emailAdminReviewModeration({
    action: "hide",
    targetType: "review",
    targetId: "rev-mod",
    bookingId: "book-mod",
    deps: moderation.deps,
  });
  assert.equal(moderationSent.success, true);
  assert.equal(moderation.db.rows.get(moderationKey).template_id, "admin_notice");

  const signupKey = "signup:barber-9:signup_pending";
  const signup = harness("accept", signupKey);
  const signupSent = await emailSuperAdminNewSignupPending({
    role: "barber",
    fullName: "Fixture User",
    email: "signup-user@fixture.test",
    barberId: "barber-9",
    deps: signup.deps,
  });
  assert.equal(signupSent.ok, true);
  assert.equal(signup.db.rows.get(signupKey).template_id, "signup_pending");
  const signupMapped = mapEmailClaim({ template_id: "signup_pending", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: signupKey });
  assert.equal(signupMapped.relationship, "account_security");

  const approvedKey = "account:approved@fixture.test:account_approved";
  const approved = harness("accept", approvedKey);
  const approvedSent = await emailUserAccountApproved({
    to: "approved@fixture.test",
    name: "Fixture",
    role: "barber",
    deps: approved.deps,
  });
  assert.equal(approvedSent.ok, true);
  assert.equal(approved.db.rows.get(approvedKey).template_id, "account_approved");
  assertAcceptedNotDelivered(approved.db.rows.get(approvedKey));

  const deniedKey = "account:denied@fixture.test:account_denied";
  const denied = harness("accept", deniedKey);
  const deniedSent = await emailUserAccountDenied({
    to: "denied@fixture.test",
    name: "Fixture",
    role: "barber",
    deps: denied.deps,
  });
  assert.equal(deniedSent.ok, true);
  assert.equal(denied.db.rows.get(deniedKey).template_id, "account_denied");

  const waitKey = "waitlist:offer-1:waitlist_offer";
  const wait = harness("accept", waitKey);
  const waitSent = await sendWaitlistOfferEmail({
    to: "phase3b-admin@fixture.test",
    customerName: "Fixture",
    offer: { id: "offer-1", slotDate: "2026-10-08", slotTime: "11:00" },
    acceptUrl: "https://ifcdcbarbersapp.com/accept",
    declineUrl: "https://ifcdcbarbersapp.com/decline",
    deps: wait.deps,
  });
  assert.equal(waitSent.ok, true);
  assert.equal(wait.db.rows.get(waitKey).template_id, "waitlist_offer");

  const digestKey = "founder:operational_digest:digest:2026-10-06";
  const digest = harness("accept", digestKey);
  const digestSent = await deliverOperationalDigestEmail({
    to: "digest@fixture.test",
    periodLabel: "today",
    bodyHtml: "<p>AURA operational insights</p>",
    fingerprint: "digest:2026-10-06",
    deps: digest.deps,
  });
  assert.equal(digestSent.ok, true);
  assert.equal(digest.db.rows.get(digestKey).template_id, "operational_digest");
  const digestMapped = mapEmailClaim({ template_id: "operational_digest", status: "sent", provider: "postmark", message_id: "pm-fixture", idempotency_key: digestKey });
  assert.equal(digestMapped.relationship, "founder");

  const starterKey = "starter:welcome:starter@fixture.test";
  const starter = harness("accept", starterKey);
  const starterSent = await sendViaResend({
    to: "starter@fixture.test",
    subject: "Welcome to IFCDC Barbers",
    html: "<p>Welcome to IFCDC Barbers.</p>",
    automationKey: "welcome",
    deps: starter.deps,
  });
  assert.equal(starterSent.ok, true);
  assert.equal(starterSent.provider, "postmark");
  assert.equal(starter.db.rows.get(starterKey).template_id, "starter_welcome");
  assert.equal(starter.resends.length, 0);
  await proveFallback((deps) => sendViaResend({
    to: "starter-b@fixture.test",
    subject: "Welcome to IFCDC Barbers",
    html: "<p>IFCDC</p>",
    automationKey: "welcome",
    deps,
  }), "starter:welcome:starter-b@fixture.test");
});

test("every remaining migrated sender falls back once and stays uncertain on timeout", async () => {
  await proveFallback((deps) => deliverLegacyAppointmentReminder({
    to: "legacy-fb@fixture.test",
    subject: "Reminder — appointment in ~30 minutes",
    html: "<p>Reminder</p>",
    text: "Reminder",
    bookingId: "book-legacy-fb",
    deps,
  }), "booking:book-legacy-fb:appointment_reminder:30m");
  await proveFallback((deps) => sendAuraReminderEmail({
    customerEmail: "reminder-2h-fb@fixture.test",
    bookingId: "book-2h-fb",
    deps,
  }, "2h"), "booking:book-2h-fb:appointment_reminder:2h");
  await proveFallback((deps) => sendAuraReminderEmail({
    customerEmail: "reminder-30m-fb@fixture.test",
    bookingId: "book-30m-fb",
    deps,
  }, "30m"), "booking:book-30m-fb:appointment_reminder:30m");
  await proveFallback((deps) => sendAuraReviewFollowupEmail({
    customerEmail: "follow-fb@fixture.test",
    bookingId: "book-follow-fb",
    deps,
  }), "booking:book-follow-fb:review_followup");
  await proveFallback((deps) => deliverFounderOperationalEmail({
    to: "founder-fb@fixture.test",
    title: "AURA: fixture",
    body: "fixture",
    event: { id: "evt-fb", event_type: "ops_update" },
    deps,
  }), "founder:evt-fb:founder_notice");
  await proveFallback((deps) => deliverFounderDailyReportEmail({
    to: "report-fb@fixture.test",
    day: "2026-10-07",
    html: "<p>IFCDC daily report</p>",
    text: "IFCDC daily report",
    deps,
  }), "founder:daily_report:2026-10-07");
  await proveFallback((deps) => deliverAdminPasswordResetEmail({
    to: "admin-reset-fb@fixture.test",
    html: "<p>Reset</p>",
    userId: "admin-fb",
    tokenHash: "aaaaaaaaaaaaaaaaEXTRA",
    deps,
  }), "account:admin-fb:password_reset:aaaaaaaaaaaaaaaa");
  await proveFallback((deps) => sendOrphanedPaymentAdminAlert({
    bookingId: "book-or-fb",
    captureId: "cap-fb",
    reason: "missing_booking",
    deps,
  }), "booking:book-or-fb:admin_notice:orphaned_payment");
  const barberDb = async (sql) => (
    String(sql).includes("FROM barbers")
      ? { rows: [{ name: "Fixture", owner_email: "barber-fb@fixture.test" }] }
      : { rows: [] }
  );
  await proveFallback((deps) => emailBarberNewReview({
    dbQuery: barberDb,
    barberId: "barber-fb",
    reviewId: "rev-fb",
    rating: 5,
    comment: "Fixture",
    deps,
  }), "review:rev-fb:barber_review:barber-fb@fixture.test");
  await proveFallback((deps) => emailCustomerReviewPrompt({
    to: "prompt-fb@fixture.test",
    customerName: "Fixture",
    barberName: "Fixture",
    bookingId: "book-prompt-fb",
    language: "en",
    deps,
  }), "booking:book-prompt-fb:review_prompt");
  await proveFallback((deps) => emailAdminReviewModeration({
    action: "hide",
    targetType: "review",
    targetId: "rev-fb",
    bookingId: "book-mod-fb",
    deps,
  }), "booking:book-mod-fb:admin_notice:moderation:rev-fb");
  await proveFallback((deps) => emailSuperAdminNewSignupPending({
    role: "barber",
    fullName: "Fixture",
    email: "signup-fb@fixture.test",
    barberId: "barber-fb",
    deps,
  }), "signup:barber-fb:signup_pending");
  await proveFallback((deps) => emailUserAccountApproved({
    to: "approved-fb@fixture.test",
    name: "Fixture",
    role: "barber",
    deps,
  }), "account:approved-fb@fixture.test:account_approved");
  await proveFallback((deps) => emailUserAccountDenied({
    to: "denied-fb@fixture.test",
    name: "Fixture",
    role: "barber",
    deps,
  }), "account:denied-fb@fixture.test:account_denied");
  await proveFallback((deps) => sendWaitlistOfferEmail({
    to: "phase3b-admin@fixture.test",
    customerName: "Fixture",
    offer: { id: "offer-fb", slotDate: "2026-10-08", slotTime: "12:00" },
    acceptUrl: "https://ifcdcbarbersapp.com/accept",
    declineUrl: "https://ifcdcbarbersapp.com/decline",
    deps,
  }), "waitlist:offer-fb:waitlist_offer");
  await proveFallback((deps) => deliverOperationalDigestEmail({
    to: "digest-fb@fixture.test",
    periodLabel: "today",
    bodyHtml: "<p>AURA digest</p>",
    fingerprint: "digest-fb",
    deps,
  }), "founder:operational_digest:digest-fb");
});

test("diagnostic test-email cannot send", async () => {
  let status = 0;
  let body = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  refuseDiagnosticTestEmail({ query: { to: "nobody@fixture.test" } }, res);
  assert.equal(status, 410);
  assert.equal(body.sendingDisabled, true);
  const route = readFileSync(`${root}testEmailRoute.cjs`, "utf8");
  const server = readFileSync(`${root}server.js`, "utf8");
  assert.equal(/sendEmail|postmark|resend|deliverTransactionalEmail/i.test(route), false);
  assert.equal(server.includes("runTestEmailSend"), false);
  assert.equal(server.includes("createAuthRouter({ sendEmail: sendClaimedEmail })"), true);
  assert.equal(server.includes('app.get("/api/test-email", handleGetTestEmail)'), true);
  assert.equal(server.includes('app.post("/api/test-email", handlePostTestEmail)'), true);
});

test("migration tests do not invoke scanners, the daily report, or HubSpot", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(src.includes("scanAnd" + "Send"), false);
  assert.equal(src.includes("generateAura" + "DailyReport"), false);
  assert.equal(src.includes("tryHub" + "Spot"), false);
  const bookingEmail = readFileSync(`${root}bookingEmail.cjs`, "utf8");
  assert.equal(bookingEmail.includes('templateId: "booking_confirmation"'), true);
  assert.equal(bookingEmail.includes('templateId: "booking_reschedule"'), true);
  assert.equal(bookingEmail.includes('templateId: "booking_cancellation"'), true);
});
