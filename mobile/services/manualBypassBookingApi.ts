import { apiFetch } from "./api";

export type BypassPaymentType = "paid_online" | "complimentary" | "pay_at_shop" | "staff_training";

export type ManualBookingPayload = {
  paymentType: BypassPaymentType;
  barberId: string;
  barberName?: string;
  customerName: string;
  /** Required for Manual Booking / Bypass Mode SMS confirmations. */
  customerPhone: string;
  /** Optional — not required for bypass bookings. */
  customerEmail?: string;
  clientUserId?: string | null;
  createClient?: boolean;
  serviceId?: string | null;
  service?: string;
  price?: number;
  date: string;
  time: string;
  notes?: string;
  reason?: string;
  tipAmount?: number;
  sendEmail?: boolean;
  /** When true, enforce barber schedule / availability. Default: false (full bypass). */
  enforceAvailability?: boolean;
  durationMinutes?: number;
};

async function readJson(res: Response) {
  return res.json().catch(() => ({}));
}

export async function fetchManualBookingPaymentTypes() {
  const res = await apiFetch("/api/admin/manual-bookings/payment-types");
  return readJson(res);
}

export async function searchManualBookingClients(q: string) {
  const query = encodeURIComponent(q);
  const res = await apiFetch(`/api/admin/manual-bookings/clients?q=${query}`);
  return readJson(res);
}

export async function createManualBypassBooking(body: ManualBookingPayload) {
  const res = await apiFetch("/api/admin/manual-bookings", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return readJson(res);
}

export async function convertManualBypassToPaid(
  bookingId: string,
  mode: "mark_paid" | "start_online" = "mark_paid",
  note?: string,
) {
  const res = await apiFetch(`/api/admin/manual-bookings/${encodeURIComponent(bookingId)}/convert-to-paid`, {
    method: "POST",
    body: JSON.stringify({ mode, note }),
  });
  return readJson(res);
}

export async function cancelManualBypassBooking(bookingId: string, note?: string) {
  const res = await apiFetch(`/api/admin/manual-bookings/${encodeURIComponent(bookingId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
  return readJson(res);
}
