/**
 * When PayPal has captured funds but booking cannot be finalized — refund and mark the booking.
 */
const { refundPayPalCapture } = require("./paypalRefund.cjs");
const { sendOrphanedPaymentAdminAlert } = require("./orphanedPaymentAlert.cjs");

/**
 * @param {object} opts
 * @param {Function} opts.dbQuery
 * @param {string} opts.bookingId
 * @param {string} opts.paypalOrderId
 * @param {string} opts.captureId
 * @param {string} [opts.customerEmail]
 * @param {number|null} [opts.capturedUsd]
 * @param {string} opts.reason
 * @param {object} [opts.extra]
 */
async function refundCapturedBookingOrAlert(opts) {
  const {
    dbQuery,
    bookingId,
    paypalOrderId,
    captureId,
    customerEmail = "",
    capturedUsd = null,
    reason = "finalize_failed_after_capture",
    extra = null,
  } = opts;

  const cap = String(captureId || "").trim();
  if (!cap) {
    await sendOrphanedPaymentAdminAlert({
      paypalOrderId,
      captureId: "",
      bookingId,
      customerEmail,
      reason: `${reason}_missing_capture_id`,
      capturedUsd,
      extra,
    });
    return { refunded: false, error: "missing_capture_id" };
  }

  if (bookingId) {
    await dbQuery(
      `UPDATE bookings SET
         paypal_capture_id = COALESCE(paypal_capture_id, $2),
         payment_status = 'refund_pending',
         booking_status = 'pending_payment',
         is_paid_booking = false
       WHERE id = $1::uuid`,
      [bookingId, cap],
    ).catch(() => {});
  }

  const refund = await refundPayPalCapture(cap, {
    amount: capturedUsd != null && Number(capturedUsd) > 0 ? Number(capturedUsd) : null,
    note: `IFCDC auto-refund: ${String(reason).slice(0, 200)}`,
  });

  if (refund.ok) {
    if (bookingId) {
      await dbQuery(
        `UPDATE bookings SET
           payment_status = 'refunded',
           booking_status = 'cancelled',
           is_paid_booking = false,
           paypal_capture_id = COALESCE(paypal_capture_id, $2),
           paypal_refund_id = $3,
           refund_amount = $4,
           refunded_at = NOW(),
           refund_reason = $5,
           cancellation_reason = $5
         WHERE id = $1::uuid`,
        [
          bookingId,
          cap,
          refund.refundId || null,
          refund.amount != null ? refund.amount : capturedUsd,
          String(reason).slice(0, 500),
        ],
      ).catch((e) => console.error("[orphan-refund] DB update failed:", e?.message || e));
    }
    await sendOrphanedPaymentAdminAlert({
      paypalOrderId,
      captureId: cap,
      bookingId,
      customerEmail,
      reason: `auto_refunded_${reason}`,
      capturedUsd: refund.amount ?? capturedUsd,
      extra: { ...(extra || {}), refundId: refund.refundId, refundStatus: refund.status },
    });
    console.log("[orphan-refund] SUCCESS", {
      paypalOrderId,
      captureId: cap,
      bookingId,
      refundId: refund.refundId,
      reason,
    });
    return { refunded: true, refundId: refund.refundId, amount: refund.amount };
  }

  await sendOrphanedPaymentAdminAlert({
    paypalOrderId,
    captureId: cap,
    bookingId,
    customerEmail,
    reason: `refund_failed_${reason}`,
    capturedUsd,
    extra: { ...(extra || {}), refundError: refund.message || refund.error },
  });
  console.error("[orphan-refund] FAILED", {
    paypalOrderId,
    captureId: cap,
    bookingId,
    error: refund.error,
    message: refund.message,
  });
  return { refunded: false, error: refund.error, message: refund.message };
}

module.exports = { refundCapturedBookingOrAlert };
