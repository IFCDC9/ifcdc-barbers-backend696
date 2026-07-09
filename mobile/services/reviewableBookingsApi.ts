import { fetchAppJson } from "./appSession";

export async function fetchReviewableBookings() {
  const data = await fetchAppJson<{ bookings?: unknown[] }>("/api/me/reviewable-bookings");
  return Array.isArray(data.bookings) ? data.bookings : [];
}
