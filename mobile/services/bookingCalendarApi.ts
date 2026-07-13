import { apiFullUrl } from "../constants/config";

/**
 * Month calendar markers for booking date picker.
 * @returns {Promise<{ days: object[], bookingWindowDays: number, today: string, lastBookableDate: string, timezone?: string }>}
 */
export async function fetchBookingCalendar({ barberId, barberName, year, month, durationMinutes }) {
  const q = new URLSearchParams();
  if (barberId != null && String(barberId).trim()) q.set("barberId", String(barberId));
  if (barberName) q.set("barberName", String(barberName));
  q.set("year", String(year));
  q.set("month", String(month));
  if (durationMinutes != null && Number(durationMinutes) > 0) {
    q.set("durationMinutes", String(Math.round(Number(durationMinutes))));
  }
  const url = apiFullUrl(`/api/app-bookings/booking-calendar?${q.toString()}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.error || `HTTP ${res.status}`);
  }
  return {
    days: Array.isArray(json.days) ? json.days : [],
    bookingWindowDays: Number(json.bookingWindowDays) || 90,
    today: json.today || "",
    lastBookableDate: json.lastBookableDate || "",
    timezone: json.timezone,
  };
}
