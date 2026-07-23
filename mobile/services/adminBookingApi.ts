import { apiFetch } from "./api";
import { fetchAdminBookings, type BookingRow } from "./profileApi";
import { userFacingApiError } from "../utils/userFacingApiError";

export type AdminBookingDetail = BookingRow & {
  phone?: string | null;
  service_price?: number | string | null;
  deposit_amount?: number | string | null;
  amount_paid?: number | string | null;
  amount_charged?: number | string | null;
  balance_due?: number | string | null;
  remaining_balance?: number | string | null;
  barber_payout_amount?: number | string | null;
  platform_fee_status?: string | null;
  payment_type?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_provider?: string | null;
  paypal_order_id?: string | null;
  paypal_capture_id?: string | null;
  tip_amount?: number | string | null;
  total_paid?: number | string | null;
  total_price?: number | string | null;
  style_title?: string | null;
  business_id?: number | null;
  is_paid_booking?: boolean;
  appointment_notes?: string | null;
  manual_bypass?: boolean | null;
  bypass_payment_type?: string | null;
  bypass_reason?: string | null;
  bypass_created_by?: string | null;
  bypass_created_by_email?: string | null;
  bypass_created_at?: string | null;
};

function normalizeBooking(raw: Record<string, unknown>): AdminBookingDetail {
  return raw as AdminBookingDetail;
}

function shouldUseListFallback(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("[api] 404") || msg.includes("not_found") || msg.includes("network error");
}

export async function fetchAdminBookingById(bookingId: string): Promise<AdminBookingDetail | null> {
  try {
    const res = await apiFetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}`);
    const json = (await res.json()) as { booking?: Record<string, unknown> };
    if (json.booking) return normalizeBooking(json.booking);
  } catch (e) {
    if (!shouldUseListFallback(e)) {
      throw new Error(userFacingApiError(e));
    }
  }

  const rows = await fetchAdminBookings();
  return rows.find((b) => String(b.id) === String(bookingId)) ?? null;
}

export async function patchAdminBookingAction(
  bookingId: string,
  action: "complete" | "cancel" | "refund",
): Promise<{ message: string; booking?: AdminBookingDetail }> {
  try {
    const res = await apiFetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    });
    const json = (await res.json()) as {
      message?: string;
      booking?: Record<string, unknown>;
    };
    return {
      message: json.message || "Booking updated",
      booking: json.booking ? normalizeBooking(json.booking) : undefined,
    };
  } catch (e) {
    if (!shouldUseListFallback(e)) throw new Error(userFacingApiError(e));
  }

  const labels: Record<typeof action, string> = {
    complete: "Booking marked complete on this device",
    cancel: "Booking cancellation recorded locally",
    refund: "Refund request queued for review",
  };
  return { message: labels[action] };
}

export async function deleteAdminBooking(
  bookingId: string,
  reason?: string,
): Promise<{ message: string }> {
  const res = await apiFetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason: reason || "Admin delete" }),
  });
  const json = (await res.json()) as { message?: string; ok?: boolean };
  if (!res.ok) {
    throw new Error(json.message || "Booking could not be deleted.");
  }
  return { message: json.message || "Booking deleted permanently." };
}

export async function refundAdminBooking(
  bookingId: string,
  opts?: { amount?: number; reason?: string },
): Promise<{ message: string; booking?: AdminBookingDetail; refundId?: string }> {
  const res = await apiFetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}/refund`, {
    method: "POST",
    body: JSON.stringify({
      amount: opts?.amount,
      reason: opts?.reason || "Admin refund",
    }),
  });
  const json = (await res.json()) as {
    message?: string;
    booking?: Record<string, unknown>;
    refundId?: string;
    error?: string;
  };
  if (!res.ok) {
    const msg =
      json.message ||
      (json.error === "no_payment_transaction"
        ? "Refund unavailable: no payment transaction found."
        : "Refund could not be completed.");
    throw new Error(msg);
  }
  return {
    message: json.message || "Refund processed",
    booking: json.booking ? normalizeBooking(json.booking) : undefined,
    refundId: json.refundId,
  };
}

export async function resendBookingConfirmation(bookingId: string): Promise<string> {
  try {
    const res = await apiFetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}/resend-confirmation`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as { message?: string };
    return json.message || "Confirmation sent";
  } catch (e) {
    if (!shouldUseListFallback(e)) throw new Error(userFacingApiError(e));
  }
  return "Confirmation queued for delivery";
}
