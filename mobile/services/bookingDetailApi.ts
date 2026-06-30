import { apiFetch } from "./api";
import { fetchAdminBookings, type BookingRow } from "./profileApi";
import { userFacingApiError } from "../utils/userFacingApiError";
import { emitScheduleUpdated } from "./scheduleEvents";

export type BookingDetail = BookingRow & {
  user_id?: string | null;
  phone?: string | null;
  business_id?: number | string | null;
  shop_name?: string | null;
  service_duration_minutes?: number | string | null;
  amount?: number | string | null;
  total_price?: number | string | null;
  deposit_amount?: number | string | null;
  amount_paid?: number | string | null;
  remaining_balance?: number | string | null;
  payment_type?: string | null;
  payment_provider?: string | null;
  paypal_order_id?: string | null;
  paypal_capture_id?: string | null;
  tip_amount?: number | string | null;
  total_paid?: number | string | null;
  style_title?: string | null;
  style_image_url?: string | null;
  is_paid_booking?: boolean;
  notes?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
  rescheduled_from_date?: string | null;
  rescheduled_from_time?: string | null;
  rescheduled_to_date?: string | null;
  rescheduled_to_time?: string | null;
  rescheduled_by?: string | null;
  rescheduled_at?: string | null;
};

function shouldUseListFallback(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("[api] 404") || msg.includes("not_found") || msg.includes("network error");
}

/**
 * Loads a single booking using the role-aware unified endpoint.
 * Falls back to the admin list (for elevated users) if the per-id route is
 * unavailable on an older deploy. Customers get nothing back from the fallback,
 * which matches the desired "404 = not yours" behavior.
 */
export async function removeBookingFromHistory(
  bookingId: string,
  reason?: string,
): Promise<{ message: string }> {
  const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason: reason || "Removed from history" }),
  });
  const json = (await res.json()) as { message?: string };
  emitScheduleUpdated();
  return { message: json.message || "Booking removed from your history." };
}

export async function fetchBookingById(bookingId: string): Promise<BookingDetail | null> {
  try {
    const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}`);
    const json = (await res.json()) as { booking?: BookingDetail; ok?: boolean };
    if (json && json.booking) return json.booking;
  } catch (e) {
    if (!shouldUseListFallback(e)) {
      throw new Error(userFacingApiError(e));
    }
  }

  try {
    const rows = await fetchAdminBookings();
    const row = rows.find((b) => String(b.id) === String(bookingId));
    return (row as BookingDetail) ?? null;
  } catch {
    return null;
  }
}

export async function cancelBookingById(
  bookingId: string,
  options: { reason?: string; blockSlot?: boolean } = {},
): Promise<{ message: string; refundReviewRequired?: boolean }> {
  try {
    const body: Record<string, unknown> = {};
    if (options.reason && options.reason.trim()) body.reason = options.reason.trim();
    if (options.blockSlot) body.blockSlot = true;
    const res = await apiFetch(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      message?: string;
      refundReviewRequired?: boolean;
    };
    emitScheduleUpdated();
    return {
      message: json.message || "Booking cancelled.",
      refundReviewRequired: json.refundReviewRequired,
    };
  } catch (e) {
    throw new Error(userFacingApiError(e));
  }
}
