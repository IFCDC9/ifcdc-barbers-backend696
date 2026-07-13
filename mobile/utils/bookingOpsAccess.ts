import { decodeJwtPayload } from "../auth/jwtSession";
import type { AppUser } from "../services/profileApi";
import { isSuperAdminUser } from "./adminAccess";

/** Platform admin/super_admin — delete booking & PayPal refund (not shop_owner). */
export function canPerformBookingDestructiveOps(
  user: AppUser | null | undefined,
  token?: string | null,
): boolean {
  if (isSuperAdminUser(user, token)) return true;
  if (String(user?.role || "").toLowerCase() === "admin") return true;

  if (token) {
    const payload = decodeJwtPayload(token);
    if (!payload) return false;
    if (payload.isSuperAdmin === true || payload.isOwner === true) return true;
    if (String(payload.role || "").toLowerCase() === "admin") return true;
  }

  return false;
}

const REFUNDED_STATUSES = new Set([
  "refunded",
  "partially_refunded",
  "refund_pending",
]);

export function bookingPaymentDisplayStatus(booking: {
  payment_status?: string | null;
  paypal_capture_id?: string | null;
  amount_paid?: number | string | null;
  amount_charged?: number | string | null;
  total_paid?: number | string | null;
}): string {
  const status = String(booking.payment_status || "unpaid").toLowerCase();
  if (REFUNDED_STATUSES.has(status)) return status;
  const capture = String(booking.paypal_capture_id || "").trim();
  const paid = Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid ?? 0);
  if (!capture && paid <= 0.01) return "unpaid";
  if (status === "deposit_paid") return "deposit_paid";
  if (status === "paid_full" || status === "paid") return "paid_in_full";
  if (paid > 0 && paid < 9999) {
    const total = Number((booking as { total_price?: number }).total_price ?? paid);
    if (total > paid + 0.02) return "partial_paid";
    return "paid_in_full";
  }
  return status || "unpaid";
}

/** Customer/barber/shop may remove unpaid or refunded rows from history (not active paid captures). */
export function canUserRemoveBookingFromHistory(booking: {
  payment_status?: string | null;
  paypal_capture_id?: string | null;
  amount_paid?: number | string | null;
  amount_charged?: number | string | null;
  total_paid?: number | string | null;
}): boolean {
  const status = String(booking.payment_status || "unpaid").toLowerCase();
  if (REFUNDED_STATUSES.has(status) || status === "refunded" || status === "partially_refunded") {
    return true;
  }
  if (status === "refund_pending") return false;
  const capture = String(booking.paypal_capture_id || "").trim();
  const paid = Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid ?? 0);
  if (capture && paid > 0.01) return false;
  if (["paid", "paid_full", "deposit_paid"].includes(status) && paid > 0.01) return false;
  return true;
}

export function bookingRemovalBlockedMessage(booking: {
  payment_status?: string | null;
  paypal_capture_id?: string | null;
}): string {
  const status = String(booking.payment_status || "").toLowerCase();
  if (status === "refund_pending") {
    return "A refund is in progress. Try again after it completes.";
  }
  return "This booking has a payment on file. Cancel the appointment first. Refunds are handled separately.";
}

export function canShowRefundClientButton(booking: {
  payment_status?: string | null;
  paypal_capture_id?: string | null;
  amount_paid?: number | string | null;
  amount_charged?: number | string | null;
  total_paid?: number | string | null;
}): boolean {
  const display = bookingPaymentDisplayStatus(booking);
  if (display === "unpaid" || REFUNDED_STATUSES.has(display)) return false;
  const capture = String(booking.paypal_capture_id || "").trim();
  if (!capture) return false;
  const paid = Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid ?? 0);
  const status = String(booking.payment_status || "").toLowerCase();
  if (paid > 0.01) return true;
  if (["paid", "paid_full", "deposit_paid", "partial_paid"].includes(display)) return true;
  // Orphan captures: payment_failed after PayPal capture but before amount_paid written
  return status === "payment_failed" || status === "payment_mismatch";
}
