import { apiFetch } from "./api";
import { SessionExpiredError } from "./sessionApi";

export async function fetchReviewableBookings() {
  const res = await apiFetch("/api/me/reviewable-bookings");
  const data = await res.json();
  if (!data?.ok) throw new Error(data?.message || "Could not load reviews");
  return Array.isArray(data.bookings) ? data.bookings : [];
}
