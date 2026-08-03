#!/usr/bin/env node
/**
 * Enqueue (or refresh) a pending booking confirmation for later resend.
 * Does NOT send email. Preserves payment/booking data references only.
 *
 *   node --import ./loadBackendEnv.mjs scripts/enqueue-pending-booking-confirmation.mjs --capture=64L950419V2825032
 *   node --import ./loadBackendEnv.mjs scripts/enqueue-pending-booking-confirmation.mjs --booking=UUID
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const {
  enqueuePendingEmailDelivery,
  KIND_BOOKING_CONFIRMATION,
  STATUS_PENDING,
  ensurePendingEmailDeliveryTable,
} = require("../pendingEmailDelivery.cjs");
const { logAuraAction } = require("../auraActionLog.cjs");

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

await ensurePendingEmailDeliveryTable(dbQuery);

const r = captureId
  ? await dbQuery(`SELECT * FROM bookings WHERE paypal_capture_id = $1 LIMIT 1`, [captureId])
  : await dbQuery(`SELECT * FROM bookings WHERE id = $1::uuid LIMIT 1`, [bookingIdArg]);

const fresh = r.rows?.[0];
if (!fresh) {
  console.error("[enqueue-pending] booking not found — cannot preserve confirmation without booking row");
  process.exit(1);
}

const toEmail = String(fresh.customer_email || "").trim();
console.log("[enqueue-pending] booking preserved", {
  id: fresh.id,
  to: toEmail,
  payment_status: fresh.payment_status,
  booking_status: fresh.booking_status,
  capture: fresh.paypal_capture_id,
  paypal_order_id: fresh.paypal_order_id,
  amount_paid: fresh.amount_paid ?? fresh.total_paid,
});

const queued = await enqueuePendingEmailDelivery(dbQuery, {
  kind: KIND_BOOKING_CONFIRMATION,
  bookingId: fresh.id,
  toEmail,
  captureId: fresh.paypal_capture_id || captureId || null,
  paypalOrderId: fresh.paypal_order_id || null,
  lastError: "Resend account under investigation — queued for delivery after restore",
  metadata: {
    paymentPreserved: true,
    source: "manual_enqueue",
    customerName: fresh.customer_name || null,
    service: fresh.service || null,
    date: fresh.date || null,
    time: fresh.time || null,
  },
});

await logAuraAction(dbQuery, {
  actor: "system",
  action: "booking_confirmation_email_pending",
  bookingId: fresh.id,
  result: STATUS_PENDING,
  metadata: {
    pendingDeliveryId: queued?.id || null,
    captureId: fresh.paypal_capture_id || captureId || null,
    toDomain: toEmail.includes("@") ? toEmail.split("@")[1] : null,
    status: STATUS_PENDING,
  },
});

console.log("[enqueue-pending] OK", {
  pendingDeliveryId: queued?.id,
  status: STATUS_PENDING,
  updated: Boolean(queued?.updated),
  created: Boolean(queued?.created),
});
process.exit(queued?.ok ? 0 : 1);
