/**
 * PayPal payment SMS — only after verified webhook processing (not client return).
 * Idempotent per (event_type + capture/order id). No full financial instrument details.
 */
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
const { normalizeToE164 } = require("./smsPhone.cjs");
const { shortRef } = require("./smsBookingNotify.cjs");

const EVENT_CATEGORY = {
  "PAYMENT.CAPTURE.COMPLETED": "payment_success",
  "PAYMENT.CAPTURE.DENIED": "payment_denied",
  "PAYMENT.CAPTURE.REFUNDED": "payment_refunded",
  "PAYMENT.CAPTURE.REVERSED": "payment_reversed",
  "PAYMENT.CAPTURE.PENDING": "payment_failed",
  "CHECKOUT.ORDER.APPROVED": null, // not a capture confirmation
  "PAYMENT.CAPTURE.DECLINED": "payment_failed",
  "CUSTOMER.DISPUTE.CREATED": null,
};

function mapPaypalEventToCategory(eventType) {
  const t = String(eventType || "");
  if (EVENT_CATEGORY[t] !== undefined) return EVENT_CATEGORY[t];
  if (/REFUND/i.test(t)) return "payment_refunded";
  if (/DENIED|DECLINED|FAILED/i.test(t)) return "payment_failed";
  if (/REVERSED|REVERSAL/i.test(t)) return "payment_reversed";
  if (/CANCEL/i.test(t)) return "payment_canceled";
  if (/COMPLETED|CAPTURED/i.test(t)) return "payment_success";
  return null;
}

function buildPaymentSmsBody(category, { amount, currency, bookingId, captureId }) {
  const ref = shortRef(bookingId) !== "N/A" ? shortRef(bookingId) : String(captureId || "").slice(-8).toUpperCase();
  const amt =
    amount != null && String(amount).trim()
      ? `${String(amount).trim()} ${String(currency || "USD").trim()}`
      : null;
  switch (category) {
    case "payment_success":
      return `IFCDC Barbers: Payment received${amt ? ` (${amt})` : ""}. Booking ref ${ref}. Thank you.`;
    case "payment_failed":
      return `IFCDC Barbers: Payment did not complete for booking ref ${ref}. Action required — no charge confirmed. Reply HELP for support.`;
    case "payment_denied":
      return `IFCDC Barbers: Payment was denied for booking ref ${ref}. Action required — contact your payment provider or try again.`;
    case "payment_refunded":
      return `IFCDC Barbers: Refund processed${amt ? ` (${amt})` : ""} for booking ref ${ref}.`;
    case "payment_reversed":
      return `IFCDC Barbers: Payment reversal noted for booking ref ${ref}. Support: service@ifcdc.org`;
    case "payment_canceled":
      return `IFCDC Barbers: Payment canceled for booking ref ${ref}.`;
    default:
      return `IFCDC Barbers: Payment update for booking ref ${ref}.`;
  }
}

/**
 * After PayPal webhook body is accepted — look up booking phone and notify.
 * Never throws.
 */
async function notifyPaymentSmsFromPaypalWebhook(dbQuery, body, opts = {}) {
  try {
    const eventType = String(body?.event_type || "");
    const category = mapPaypalEventToCategory(eventType);
    if (!category) return { ok: true, skipped: true, reason: "event_not_sms_mapped" };

    const resource = body.resource || {};
    const captureId = String(resource.id || "").trim();
    const orderId = String(
      resource.supplementary_data?.related_ids?.order_id || resource.order_id || "",
    ).trim();
    const amount = resource.amount?.value ?? resource.seller_payable_breakdown?.gross_amount?.value ?? null;
    const currency =
      resource.amount?.currency_code ??
      resource.seller_payable_breakdown?.gross_amount?.currency_code ??
      "USD";

    let booking = null;
    if (typeof dbQuery === "function" && (captureId || orderId)) {
      const r = await dbQuery(
        `SELECT id, user_id, customer_email, phone, customer_name, paypal_capture_id, paypal_order_id
         FROM bookings
         WHERE ($1 <> '' AND paypal_capture_id = $1)
            OR ($2 <> '' AND paypal_order_id = $2)
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [captureId, orderId],
      );
      booking = r.rows?.[0] || null;
    }

    let to = opts.to || null;
    if (!to && booking?.phone) {
      const n = normalizeToE164(booking.phone);
      if (n.ok) to = n.e164;
    }
    if (!to && booking?.user_id) {
      const u = await dbQuery(
        `SELECT phone_e164, phone FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [booking.user_id],
      );
      const row = u.rows?.[0];
      const n = normalizeToE164(row?.phone_e164 || row?.phone || "");
      if (n.ok) to = n.e164;
    }
    if (!to) return { ok: true, skipped: true, reason: "no_phone" };

    const paymentRef = captureId || orderId || String(body.id || "");
    const idempotencyKey = `paypal:${eventType}:${paymentRef}`;
    const bodyText = buildPaymentSmsBody(category, {
      amount,
      currency,
      bookingId: booking?.id,
      captureId,
    });
    const publicBase =
      opts.publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || "";

    return await sendTransactionalSms(dbQuery, {
      to,
      body: bodyText,
      category,
      bookingId: booking?.id || null,
      paymentRef,
      userId: booking?.user_id || null,
      idempotencyKey,
      force: Boolean(opts.force),
      statusCallbackUrl: publicBase
        ? `${String(publicBase).replace(/\/$/, "")}/api/sms/status`
        : null,
    });
  } catch (e) {
    console.warn("[sms-payment] webhook notify failed (non-fatal):", e?.message || e);
    return { ok: false, reason: "exception", error: e?.message || String(e) };
  }
}

module.exports = {
  mapPaypalEventToCategory,
  buildPaymentSmsBody,
  notifyPaymentSmsFromPaypalWebhook,
  EVENT_CATEGORY,
};
