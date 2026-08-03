#!/usr/bin/env node
/**
 * Resend paid booking confirmation email for a capture/booking id.
 *
 *   node --import ./loadBackendEnv.mjs scripts/resend-booking-confirmation.mjs --capture=64L950419V2825032
 *   node --import ./loadBackendEnv.mjs scripts/resend-booking-confirmation.mjs --booking=3fbbf6ea-9ada-404a-9b1e-700da37b7264
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const { sendBookingEmail, isDeliverableCustomerEmail } = require("../bookingEmail.cjs");
const { logAuraAction } = require("../auraActionLog.cjs");
const { getMailFrom, getResendApiKey, isResendConfigured } = require("../emailResend.cjs");
const {
  PAYMENT_STATUS,
  bookingPaymentViewFromRow,
} = require("../bookingPaymentSettlement.cjs");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
}

const captureId = arg("capture");
const bookingIdArg = arg("booking");

if (!captureId && !bookingIdArg) {
  console.error("Usage: --capture=PAYPAL_CAPTURE_ID or --booking=UUID");
  process.exit(1);
}

console.log("[resend] Resend configured:", isResendConfigured());
console.log("[resend] MAIL_FROM:", getMailFrom());
console.log("[resend] key prefix:", (() => {
  const k = getResendApiKey();
  return k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "(missing)";
})());

const r = captureId
  ? await dbQuery(
      `SELECT * FROM bookings WHERE paypal_capture_id = $1 LIMIT 1`,
      [captureId],
    )
  : await dbQuery(`SELECT * FROM bookings WHERE id = $1::uuid LIMIT 1`, [bookingIdArg]);

const fresh = r.rows?.[0];
if (!fresh) {
  console.error("[resend] booking not found");
  process.exit(1);
}

const toEmail = String(fresh.customer_email || "").trim();
console.log("[resend] booking", {
  id: fresh.id,
  to: toEmail,
  payment_status: fresh.payment_status,
  booking_status: fresh.booking_status,
  capture: fresh.paypal_capture_id,
  amount_paid: fresh.amount_paid ?? fresh.total_paid,
});

if (!isDeliverableCustomerEmail(toEmail)) {
  console.error("[resend] customer email not deliverable:", toEmail);
  process.exit(1);
}

try {
  const view = bookingPaymentViewFromRow(fresh);
  const mail = await sendBookingEmail({
    name: fresh.customer_name || "Guest",
    email: toEmail,
    service: fresh.service || "Haircut",
    servicePrice: view.servicePrice,
    serviceDuration: fresh.service_duration_minutes,
    date: String(fresh.date || "").slice(0, 10),
    time: String(fresh.time || "").slice(0, 5),
    paymentStatus: PAYMENT_STATUS.PAID_IN_FULL,
    paymentId: fresh.paypal_capture_id,
    captureId: fresh.paypal_capture_id,
    barberName: fresh.barber_name,
    platformFee: view.platformFee,
    tipAmount: view.tipAmount,
    amountCharged: view.amountCharged,
    amountPaid: view.amountPaid,
    balanceDue: 0,
    bookingId: fresh.id,
    bookingRow: fresh,
  });
  const { markPendingEmailSent } = require("../pendingEmailDelivery.cjs");
  await markPendingEmailSent(dbQuery, {
    bookingId: fresh.id,
    messageId: mail?.messageId || null,
  });
  await logAuraAction(dbQuery, {
    actor: "system",
    action: "booking_confirmation_resent",
    bookingId: fresh.id,
    result: "sent",
    metadata: {
      messageId: mail?.messageId || null,
      captureId: fresh.paypal_capture_id,
      toDomain: toEmail.split("@")[1] || null,
    },
  });
  console.log("[resend] SUCCESS", { messageId: mail?.messageId, to: toEmail });
  process.exit(0);
} catch (e) {
  const err = e?.message || String(e);
  const {
    enqueuePendingEmailDelivery,
    KIND_BOOKING_CONFIRMATION,
    STATUS_PENDING,
  } = require("../pendingEmailDelivery.cjs");
  await enqueuePendingEmailDelivery(dbQuery, {
    kind: KIND_BOOKING_CONFIRMATION,
    bookingId: fresh.id,
    toEmail,
    captureId: fresh.paypal_capture_id || null,
    paypalOrderId: fresh.paypal_order_id || null,
    lastError: err,
    metadata: { source: "manual_resend_failed", paymentPreserved: true },
  });
  await logAuraAction(dbQuery, {
    actor: "system",
    action: "booking_confirmation_resent",
    bookingId: fresh.id,
    result: STATUS_PENDING,
    metadata: { error: err, captureId: fresh.paypal_capture_id, status: STATUS_PENDING },
  });
  console.error("[resend] FAILED — left as pending_delivery:", err);
  process.exit(1);
}
