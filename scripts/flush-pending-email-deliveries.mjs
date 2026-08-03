#!/usr/bin/env node
/**
 * Flush pending booking confirmation emails after Resend account restore.
 * Does not change RESEND_* / MAIL_FROM. Payment rows are never modified.
 *
 * Dry-run (default): list pending only
 *   node --import ./loadBackendEnv.mjs scripts/flush-pending-email-deliveries.mjs
 *
 * Send:
 *   node --import ./loadBackendEnv.mjs scripts/flush-pending-email-deliveries.mjs --send
 *
 * Limit:
 *   ... --send --limit=10
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const { sendBookingEmail, isDeliverableCustomerEmail } = require("../bookingEmail.cjs");
const { logAuraAction } = require("../auraActionLog.cjs");
const { getMailFrom, isResendConfigured } = require("../emailResend.cjs");
const {
  PAYMENT_STATUS,
  bookingPaymentViewFromRow,
} = require("../bookingPaymentSettlement.cjs");
const {
  listPendingEmailDeliveries,
  markPendingEmailSent,
  KIND_BOOKING_CONFIRMATION,
  STATUS_PENDING,
  ensurePendingEmailDeliveryTable,
} = require("../pendingEmailDelivery.cjs");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
}

const doSend = hasFlag("send");
const limit = Number(arg("limit") || 50) || 50;

await ensurePendingEmailDeliveryTable(dbQuery);
const pending = await listPendingEmailDeliveries(dbQuery, {
  kind: KIND_BOOKING_CONFIRMATION,
  limit,
});

console.log("[flush-pending] Resend configured:", isResendConfigured());
console.log("[flush-pending] MAIL_FROM:", getMailFrom());
console.log("[flush-pending] pending count:", pending.length);
console.log(
  "[flush-pending] mode:",
  doSend ? "SEND" : "DRY-RUN (pass --send to deliver)",
);

for (const row of pending) {
  console.log("[flush-pending] item", {
    id: row.id,
    booking_id: row.booking_id,
    to: row.to_email,
    capture_id: row.capture_id,
    status: row.status,
    last_error: row.last_error,
    attempts: row.attempts,
  });
}

if (!doSend) {
  process.exit(0);
}

if (!pending.length) {
  console.log("[flush-pending] nothing to send");
  process.exit(0);
}

let sent = 0;
let failed = 0;

for (const pendingRow of pending) {
  const bookingId = pendingRow.booking_id;
  if (!bookingId) {
    console.error("[flush-pending] skip: missing booking_id", pendingRow.id);
    failed += 1;
    continue;
  }
  const br = await dbQuery(`SELECT * FROM bookings WHERE id = $1::uuid LIMIT 1`, [bookingId]);
  const fresh = br.rows?.[0];
  if (!fresh) {
    console.error("[flush-pending] skip: booking missing", bookingId);
    failed += 1;
    continue;
  }
  const toEmail = String(pendingRow.to_email || fresh.customer_email || "").trim();
  if (!isDeliverableCustomerEmail(toEmail)) {
    console.error("[flush-pending] skip: undeliverable email", toEmail, bookingId);
    failed += 1;
    continue;
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
      paymentId: fresh.paypal_capture_id || pendingRow.capture_id,
      captureId: fresh.paypal_capture_id || pendingRow.capture_id,
      barberName: fresh.barber_name,
      platformFee: view.platformFee,
      tipAmount: view.tipAmount,
      amountCharged: view.amountCharged,
      amountPaid: view.amountPaid,
      balanceDue: 0,
      bookingId: fresh.id,
      bookingRow: fresh,
    });
    await markPendingEmailSent(dbQuery, {
      id: pendingRow.id,
      messageId: mail?.messageId || null,
    });
    await logAuraAction(dbQuery, {
      actor: "system",
      action: "booking_confirmation_pending_flushed",
      bookingId: fresh.id,
      result: "sent",
      metadata: {
        pendingDeliveryId: pendingRow.id,
        messageId: mail?.messageId || null,
        captureId: fresh.paypal_capture_id || pendingRow.capture_id,
      },
    });
    sent += 1;
    console.log("[flush-pending] SENT", {
      pendingId: pendingRow.id,
      bookingId: fresh.id,
      to: toEmail,
      messageId: mail?.messageId,
    });
  } catch (e) {
    failed += 1;
    const err = e?.message || String(e);
    await dbQuery(
      `UPDATE pending_email_deliveries
       SET last_error = $2, attempts = attempts + 1, updated_at = NOW()
       WHERE id = $1::uuid AND status = $3`,
      [pendingRow.id, String(err).slice(0, 2000), STATUS_PENDING],
    );
    await logAuraAction(dbQuery, {
      actor: "system",
      action: "booking_confirmation_pending_flushed",
      bookingId: fresh.id,
      result: STATUS_PENDING,
      metadata: { pendingDeliveryId: pendingRow.id, error: err },
    });
    console.error("[flush-pending] FAILED (still pending_delivery):", err, {
      pendingId: pendingRow.id,
      bookingId: fresh.id,
    });
  }
}

console.log("[flush-pending] done", { sent, failed, remainingMode: "pending_delivery kept on failure" });
process.exit(failed ? 1 : 0);
