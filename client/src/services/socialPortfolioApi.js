import { getApiOrigin } from "./api.js";
import { getAdminAuthHeaders, getStoredToken } from "../lib/authHeaders.js";
import { authenticatedFetch, authenticatedJson } from "../lib/appSession.js";

function authHeaders() {
  const token = getStoredToken();
  return token
    ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
    : { Accept: "application/json" };
}

function optionalAuthHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" };
}

export async function fetchPortfolioCategories() {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/portfolio/meta/categories`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchPublicPortfolio(slugOrId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/portfolio/${encodeURIComponent(String(slugOrId))}`, {
    headers: { ...optionalAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchDiscoverPhotos(filters = {}) {
  const origin = getApiOrigin();
  const q = new URLSearchParams();
  if (filters.styleCategory) q.set("styleCategory", filters.styleCategory);
  if (filters.limit) q.set("limit", String(filters.limit));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const res = await fetch(`${origin}/api/portfolio/discover${suffix}`, {
    headers: optionalAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchReviewableBookings() {
  const data = await authenticatedJson("/api/me/reviewable-bookings", { headers: authHeaders() });
  return {
    ok: true,
    bookings: Array.isArray(data?.bookings) ? data.bookings : [],
  };
}

export async function submitBookingReview(bookingId, body) {
  const res = await authenticatedFetch(`/api/bookings/${encodeURIComponent(String(bookingId))}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchBookingReviewStatus(bookingId) {
  const res = await authenticatedFetch(`/api/bookings/${encodeURIComponent(String(bookingId))}/review-status`, {
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function uploadReviewPhotos(reviewId, files, meta = {}) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  if (meta.barberName) form.append("barberName", meta.barberName);
  if (meta.photoType) form.append("photoType", meta.photoType);
  if (meta.styleCategory) form.append("styleCategory", meta.styleCategory);
  if (meta.caption) form.append("caption", meta.caption);
  const res = await authenticatedFetch(`/api/reviews/${encodeURIComponent(String(reviewId))}/photos`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function updateCustomerReview(reviewId, body) {
  const res = await authenticatedFetch(`/api/reviews/${encodeURIComponent(String(reviewId))}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function deleteCustomerReview(reviewId) {
  const res = await authenticatedFetch(`/api/reviews/${encodeURIComponent(String(reviewId))}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function replyToReview(reviewId, reply) {
  const res = await authenticatedFetch(`/api/reviews/${encodeURIComponent(String(reviewId))}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ reply }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function togglePhotoLike(photoId) {
  const res = await authenticatedFetch(`/api/photos/${encodeURIComponent(String(photoId))}/like`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function followBarber(barberId) {
  const res = await authenticatedFetch(`/api/barbers/${encodeURIComponent(String(barberId))}/follow`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function unfollowBarber(barberId) {
  const res = await authenticatedFetch(`/api/barbers/${encodeURIComponent(String(barberId))}/follow`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function reportContent(body) {
  const res = await authenticatedFetch(`/api/content/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchContentReports() {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/content/reports`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function resolveContentReport(reportId, body) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/content/reports/${encodeURIComponent(reportId)}`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function hideReview(reviewId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/reviews/${encodeURIComponent(reviewId)}/visibility`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ status: "hidden" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function removeReview(reviewId, reason = "policy_violation") {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/reviews/${encodeURIComponent(reviewId)}`, {
    method: "DELETE",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function restoreReviewAdmin(reviewId, reason = "restored") {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/reviews/${encodeURIComponent(reviewId)}/restore`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchAdminReviews(params = {}) {
  const origin = getApiOrigin();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v).trim() !== "") q.set(k, String(v));
  }
  const res = await fetch(`${origin}/api/admin/reviews${q.toString() ? `?${q}` : ""}`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function hidePhoto(photoId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/photos/${encodeURIComponent(photoId)}/visibility`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ status: "hidden" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}
