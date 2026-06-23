/**
 * API base URL:
 * - **LAN / mobile dev:** set `VITE_API_URL=http://<LAN-IP>:5050` in `client/.env`.
 * - **Production:** leave unset for same-origin `/api/...` when serving static + API together.
 */

import { API_BASE_URL, PRODUCTION_API_ORIGIN } from "../config/api.js";
import { resolveStyleImageUrl } from "../lib/styleImageUrl.js";
import { getAdminAuthHeaders, getAdminKeyHeadersOnly, getStoredToken } from "../lib/authHeaders.js";

/**
 * Resolved API origin for absolute URLs (e.g. `/api/book`, `/api/login`).
 * When using a relative API base (Vite dev proxy), this must be the **page origin** (e.g. :5173),
 * not :5050 — otherwise fetch bypasses the proxy and hits CORS / connection errors ("Failed to fetch").
 */
export function getApiOrigin() {
  const b = getApiBase();
  if (b !== undefined && b !== null && String(b).trim() !== "") {
    return String(b).replace(/\/$/, "");
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    const host = String(window.location.hostname || "").toLowerCase();
    if (
      import.meta.env.PROD &&
      (host === "ifcdcbarbersapp.com" ||
        host.endsWith(".ifcdcbarbersapp.com") ||
        host.includes("ifcdc-barbers-frontend"))
    ) {
      return PRODUCTION_API_ORIGIN;
    }
    return window.location.origin;
  }
  if (API_BASE_URL) return String(API_BASE_URL).replace(/\/$/, "");
  return String(import.meta.env.VITE_API_URL || "").trim() || "";
}

/** DELETE /api/auth/account — permanently removes the signed-in user (App Store 5.1.1(v)). */
export async function deleteMyAccount() {
  const origin = getApiOrigin();
  let token = "";
  try {
    token = getStoredToken();
  } catch {
    /* ignore */
  }
  if (!token) {
    throw new Error("Sign in again to delete your account.");
  }

  const res = await fetch(`${origin}/api/auth/account`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Client-Source": "website",
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Account deletion failed (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Account deletion failed (HTTP ${res.status})`);
  }
  return data;
}

export async function login(email, password) {
  const origin = getApiOrigin();
  const payload = { email, password };

  // Prefer new auth endpoint; fallback to legacy /api/login for older servers.
  let res = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) {
    res = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Login: server returned non-JSON (HTTP ${res.status}). Is the API running?`);
  }
  if (!res.ok) {
    if (res.status === 401) {
      return { success: false, ...data };
    }
    throw new Error(data?.error || data?.message || `Login failed (HTTP ${res.status})`);
  }
  return data;
}

export async function register({ name, email, password, role, accountType }) {
  const origin = getApiOrigin();
  const resolvedRole = accountType || role;
  const payload = { name, email, password, role: resolvedRole, accountType: resolvedRole };
  let res = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) {
    // legacy
    res = await fetch(`${origin}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Register: server returned non-JSON (HTTP ${res.status}). Is the API running?`);
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Register failed (HTTP ${res.status})`);
  }
  return data;
}

export async function forgotPassword(email) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Forgot password: server returned non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

export async function resetPassword({ token, newPassword }) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Reset password: server returned non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Reset failed (HTTP ${res.status})`);
  }
  return data;
}

export function getApiBase() {
  const raw = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw).replace(/\/$/, "");
  }
  // Split-host production (ifcdcbarbersapp.com static → backend696 API).
  // Reads already used getApiOrigin(); uploads must hit the same backend.
  if (typeof window !== "undefined" && window.location?.origin) {
    const host = String(window.location.hostname || "").toLowerCase();
    if (
      import.meta.env.PROD &&
      (host === "ifcdcbarbersapp.com" ||
        host.endsWith(".ifcdcbarbersapp.com") ||
        host.includes("ifcdc-barbers-frontend"))
    ) {
      return PRODUCTION_API_ORIGIN;
    }
  }
  return "";
}

/** Short label for UI (e.g. Home) — reflects VITE_API_BASE or dev proxy. */
export function getApiDisplayLabel() {
  const base = getApiBase();
  if (base === "" && import.meta.env.DEV && typeof window !== "undefined") {
    return `${window.location.origin} (Vite) → API :5050`;
  }
  if (base) return base;
  return "—";
}

function assertResolvableApiBase(base) {
  if (base !== "") return;
  if (import.meta.env.DEV && typeof window !== "undefined") return;
  throw new Error("Could not resolve API URL. Set VITE_API_URL in client/.env and restart Vite.");
}

/** Quick check that the backend is reachable (GET /health). */
export async function getHealth() {
  const base = getApiBase();
  try {
    assertResolvableApiBase(base);
  } catch (e) {
    return { ok: false, error: e?.message || "Could not resolve API base URL" };
  }
  const url = `${base}/health`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, url, data };
  } catch (e) {
    return { ok: false, url, error: e?.message || "Network error" };
  }
}

/** Absolute URL for a path returned by the API. Rejects dead /uploads and HEIC/HEIF paths. */
export function mediaUrl(path) {
  if (!path) return "";
  return resolveStyleImageUrl(path, getApiOrigin());
}

export async function getBarbers() {
  const origin = getApiOrigin();
  const url = `${origin}/barbers`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new Error(
      `${e?.message || "Network error"} — ${url}. Run node server.js from the project root, then npm run dev:all (or npm run dev:client). In dev, API is proxied from this page to port 5050.`
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text?.slice(0, 200) || `HTTP ${res.status} from ${url}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Not JSON from ${url}`);
  }
}

/**
 * Live barber deposit + service list for booking UI (public, no auth).
 * @param {number} barberId
 * @returns {Promise<object | null>}
 */
export async function fetchBarberPublicPricing(barberId) {
  const id = String(barberId ?? "").trim();
  if (!id) return null;
  const base = getApiBase();
  try {
    assertResolvableApiBase(base);
  } catch {
    return null;
  }
  const url = `${base}/api/barber/public/${encodeURIComponent(id)}/pricing`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) return null;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Server-authoritative booking charge (style + platform fee + tip). POST public JSON.
 * @param {number} barberId
 * @param {{ styleId: string, paymentType?: string, tipPercent?: number, tipAmount?: number }} body
 */
export async function fetchBookingQuote(barberId, body) {
  const id = String(barberId ?? "").trim();
  if (!id) return null;
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/api/barber/public/${encodeURIComponent(id)}/booking-quote`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  if (!res.ok) throw new Error(data?.message || data?.error || `Quote failed (HTTP ${res.status})`);
  return data;
}

/**
 * Valid JWT first; otherwise `x-admin-key` (legacy dev / ops fallback).
 */
function getJwtOrAdminKeyHeaders() {
  return getAdminAuthHeaders();
}

async function fetchStylesList(url, headers) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = text ? JSON.parse(text) : {};
  return Array.isArray(j?.styles) ? j.styles : [];
}

export async function getStylesAll() {
  const origin = getApiOrigin();
  const authHeaders = getJwtOrAdminKeyHeaders();
  const manageUrl = `${origin}/api/styles/manage/all`;
  const publicUrl = `${origin}/api/styles`;

  if (authHeaders.Authorization || authHeaders["x-admin-key"]) {
    try {
      return await fetchStylesList(manageUrl, authHeaders);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        const adminHeaders = getAdminKeyHeadersOnly();
        if (adminHeaders["x-admin-key"] && !authHeaders["x-admin-key"]) {
          try {
            return await fetchStylesList(manageUrl, adminHeaders);
          } catch {
            /* fall through to public */
          }
        }
      }
    }
  }
  return fetchStylesList(publicUrl, {});
}

export async function getStylesForBarber(barberId) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/api/styles/${encodeURIComponent(barberId)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
  const j = text ? JSON.parse(text) : {};
  return Array.isArray(j?.styles) ? j.styles : [];
}

export async function createStyle({ barberId, title, description, category, file, price }) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  if (!file) {
    throw new Error("Image file is required. Select a photo before saving.");
  }
  const url = `${base}/api/styles`;
  const fd = new FormData();
  if (barberId != null) fd.append("barberId", String(barberId));
  fd.append("title", String(title || ""));
  fd.append("description", String(description || ""));
  fd.append("category", String(category || "other"));
  const p = Number(price);
  if (Number.isFinite(p) && p > 0) fd.append("price", String(p));
  fd.append("image", file, file.name || "style.jpg");

  const res = await fetch(url, {
    method: "POST",
    headers: { ...getJwtOrAdminKeyHeaders(), Accept: "application/json" },
    body: fd,
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  if (!j?.style?.id) {
    throw new Error("Photo upload did not return a saved style. Please retry.");
  }
  if (j.persisted === false) {
    throw new Error("Photo was not saved to the database. Please retry.");
  }
  return j.style;
}

/** Upload multiple gallery photos at once (up to 25 per request). */
export async function createStylesBatch({ barberId, title, description, category, files, price }) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) throw new Error("Select at least one image file.");
  const url = `${base}/api/styles/batch`;
  const fd = new FormData();
  if (barberId != null) fd.append("barberId", String(barberId));
  fd.append("title", String(title || ""));
  fd.append("description", String(description || ""));
  fd.append("category", String(category || "other"));
  const p = Number(price);
  if (Number.isFinite(p) && p > 0) fd.append("price", String(p));
  for (const file of list) {
    fd.append("images", file, file.name || "style.jpg");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { ...getJwtOrAdminKeyHeaders(), Accept: "application/json" },
    body: fd,
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  const styles = Array.isArray(j?.styles) ? j.styles : [];
  if (!styles.length) {
    throw new Error(j?.message || "No photos were saved. Please retry.");
  }
  return styles;
}

/** Reorder gallery photos — pass ordered style ids (gal-* first in desired order). */
export async function reorderStyleGallery({ barberId, orderedIds }) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/api/styles/reorder`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...getJwtOrAdminKeyHeaders(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ barberId, orderedIds }),
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return j;
}

export async function updateStyle(id, patch) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/api/styles/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...getJwtOrAdminKeyHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch || {}),
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return j?.style;
}

export async function deleteStyle(id) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/api/styles/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: "DELETE", headers: { ...getJwtOrAdminKeyHeaders(), Accept: "application/json" } });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return true;
}

export async function deleteBarber(id) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/barbers/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json", ...getJwtOrAdminKeyHeaders() },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { success: true };
  }
}

export async function uploadBarberPhoto(barberId, file) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/barbers/${encodeURIComponent(barberId)}/photo`;
  const fd = new FormData();
  fd.append("photo", file);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...getJwtOrAdminKeyHeaders(), Accept: "application/json" },
    body: fd,
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return j;
}

export async function deleteBarberPhoto(barberId) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/barbers/${encodeURIComponent(barberId)}/photo`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...getJwtOrAdminKeyHeaders(), Accept: "application/json" },
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { message: text };
  }
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return j;
}

/** PATCH barber payment settings (`paymentMode`, `splitPercent`, `active`). */
export async function patchBarber(id, body) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/barbers/${encodeURIComponent(id)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getJwtOrAdminKeyHeaders() },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    throw new Error(`${e?.message || "Network error"} — ${url}`);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.error || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

/** Multipart barber create (`name` + `photo` or legacy `image`). Do not set Content-Type — browser sets boundary. */
export async function createBarberFormData(formData) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/barbers`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: getJwtOrAdminKeyHeaders(),
      body: formData,
    });
  } catch (e) {
    throw new Error(
      `${e?.message || "Network error"} — ${url}. Ensure the API is running on port 5050.`
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from server");
  }
}

/** Append multiple files as field name `styles` (multer upload.array). */
export async function uploadBarberStyles(barberId, files) {
  const origin = getApiOrigin();
  const id = String(barberId ?? "").trim();
  if (!id) {
    throw new Error("Barber id is required. Refresh the admin page and try again.");
  }
  if (!files?.length) {
    throw new Error("Select at least one image");
  }
  const url = `${origin}/barbers/${encodeURIComponent(id)}/styles`;
  const formData = new FormData();
  for (const f of files) {
    formData.append("styles", f, f.name || "style.jpg");
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: getJwtOrAdminKeyHeaders(),
      body: formData,
    });
  } catch (e) {
    throw new Error(`${e?.message || "Network error"} — ${url}`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data?.message ||
      (data?.error === "not_found"
        ? `Barber not found (${id}). Refresh the page — barber ids must be UUIDs from production.`
        : data?.error) ||
      text?.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/** Replace a style/service photo (POST /api/styles/:id/image). */
export async function replaceStyleImage(styleId, file) {
  const origin = getApiOrigin();
  const id = String(styleId ?? "").trim();
  if (!id || !file) throw new Error("Style id and image file are required");
  const url = `${origin}/api/styles/${encodeURIComponent(id)}/image`;
  const fd = new FormData();
  fd.append("image", file, file.name || "style.jpg");
  const res = await fetch(url, {
    method: "POST",
    headers: getJwtOrAdminKeyHeaders(),
    body: fd,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

/** Paid bookings + revenue totals for Admin Money Dashboard (GET /api/admin/stats). */
export async function getAdminStats() {
  const origin = getApiOrigin();
  const url = `${origin}/api/admin/stats`;
  const headers = { Accept: "application/json", ...getJwtOrAdminKeyHeaders() };

  const res = await fetch(url, { headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

/** Mark a deposit booking as fully paid (admin JWT or x-admin-key). */
export async function markBookingFullyPaid(id) {
  const origin = getApiOrigin();
  const url = `${origin}/api/admin/bookings/${encodeURIComponent(id)}/mark-fully-paid`;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...getJwtOrAdminKeyHeaders(),
  };

  const res = await fetch(url, { method: "PATCH", headers, body: "{}" });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

/** Mark a deposit booking as fully paid (admin/super_admin, barber, or x-admin-key). */
export async function markBookingPaid(id) {
  const origin = getApiOrigin();
  const url = `${origin}/api/bookings/${encodeURIComponent(id)}/mark-paid`;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...getJwtOrAdminKeyHeaders(),
  };

  const res = await fetch(url, { method: "POST", headers, body: "{}" });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

export async function getBookings() {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/bookings`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from server");
  }
}

export async function createBooking(payload) {
  const base = getApiBase();
  assertResolvableApiBase(base);
  const url = `${base}/bookings`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`${e?.message || "Network error"} — ${url}`);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.error || text?.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

/** Soft-delete a booking (platform admin JWT or x-admin-key). */
export async function deleteBooking(id, reason = "Admin delete") {
  const origin = getApiOrigin();
  const url = `${origin}/api/admin/bookings/${encodeURIComponent(id)}`;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...getJwtOrAdminKeyHeaders(),
  };

  const res = await fetch(url, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ reason }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || text?.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data;
}

function servicePhotoHeaders() {
  return { Accept: "application/json", ...getJwtOrAdminKeyHeaders() };
}

/** List gallery photos linked to a bookable service. */
export async function getServicePhotos(serviceId, scopeQuery = "") {
  const origin = getApiOrigin();
  const id = encodeURIComponent(String(serviceId));
  const res = await fetch(`${origin}/api/barber/services/${id}/photos${scopeQuery}`, {
    headers: servicePhotoHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

/** Upload one or more photos for a service (gallery-backed, syncs cover). */
export async function uploadServicePhotos(serviceId, files, scopeQuery = "", { isPrimary = true } = {}) {
  const origin = getApiOrigin();
  const id = encodeURIComponent(String(serviceId));
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (!list.length) throw new Error("Image file is required");

  const uploaded = [];
  for (const file of list) {
    const fd = new FormData();
    fd.append("image", file, file.name || "service.jpg");
    if (isPrimary && !uploaded.length) fd.append("isPrimary", "true");
    const res = await fetch(`${origin}/api/barber/services/${id}/photos${scopeQuery}`, {
      method: "POST",
      headers: servicePhotoHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    uploaded.push(data);
  }
  return uploaded.length === 1 ? uploaded[0] : uploaded;
}

export async function setServicePhotoPrimary(serviceId, galleryId, scopeQuery = "") {
  const origin = getApiOrigin();
  const id = encodeURIComponent(String(serviceId));
  const res = await fetch(`${origin}/api/barber/services/${id}/photos/primary${scopeQuery}`, {
    method: "PATCH",
    headers: { ...servicePhotoHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ galleryId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function reorderServicePhotos(serviceId, orderedIds, scopeQuery = "") {
  const origin = getApiOrigin();
  const id = encodeURIComponent(String(serviceId));
  const res = await fetch(`${origin}/api/barber/services/${id}/photos/reorder${scopeQuery}`, {
    method: "PATCH",
    headers: { ...servicePhotoHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function deleteServicePhoto(serviceId, photoId, scopeQuery = "") {
  const origin = getApiOrigin();
  const sid = encodeURIComponent(String(serviceId));
  const pid = encodeURIComponent(String(photoId));
  const res = await fetch(`${origin}/api/barber/services/${sid}/photos/${pid}${scopeQuery}`, {
    method: "DELETE",
    headers: servicePhotoHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

/** Global barber roster for super admin / shop owners (GET /api/admin/barbers). */
export async function fetchAdminBarbers(filters = {}) {
  const origin = getApiOrigin();
  const q = new URLSearchParams();
  if (filters.shop) q.set("shop", filters.shop);
  if (filters.city) q.set("city", filters.city);
  if (filters.state) q.set("state", filters.state);
  if (filters.active) q.set("active", filters.active);
  if (filters.activeInactive) q.set("activeInactive", filters.activeInactive);
  if (filters.pendingApproval) q.set("pendingApproval", "true");
  if (filters.sort) q.set("sort", filters.sort);
  if (filters.registrationDate) q.set("registrationDate", filters.registrationDate);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const res = await fetch(`${origin}/api/admin/barbers${suffix}`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

function adminBarberId(id) {
  return encodeURIComponent(String(id ?? "").trim());
}

async function adminBarberPatch(path, body) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}${path}`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchAdminBarberDetail(barberId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/barbers/${adminBarberId(barberId)}`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function patchAdminBarberVerification(barberId, status) {
  return adminBarberPatch(`/api/admin/barbers/${adminBarberId(barberId)}/verification`, { status });
}

export async function patchAdminBarberAccountStatus(barberId, status) {
  return adminBarberPatch(`/api/admin/barbers/${adminBarberId(barberId)}/account-status`, { status });
}

export async function patchAdminBarberProfile(barberId, body) {
  return adminBarberPatch(`/api/admin/barbers/${adminBarberId(barberId)}`, body);
}

export async function assignAdminBarberShop(barberId, businessId, shopName) {
  return adminBarberPatch(`/api/admin/barbers/${adminBarberId(barberId)}/assign-shop`, { businessId, shopName });
}

export async function patchAdminBarberSubscription(barberId, tier) {
  return adminBarberPatch(`/api/admin/barbers/${adminBarberId(barberId)}/subscription`, { tier });
}

export async function deleteAdminBarber(barberId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/barbers/${adminBarberId(barberId)}`, {
    method: "DELETE",
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

/** Global shop roster for super admin / shop owners (GET /api/admin/shops). */
export async function fetchAdminShops(filters = {}) {
  const origin = getApiOrigin();
  const q = new URLSearchParams();
  if (filters.shop) q.set("shop", filters.shop);
  if (filters.city) q.set("city", filters.city);
  if (filters.state) q.set("state", filters.state);
  if (filters.status) q.set("status", filters.status);
  if (filters.pendingApproval) q.set("pendingApproval", "true");
  if (filters.sort) q.set("sort", filters.sort);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const res = await fetch(`${origin}/api/admin/shops${suffix}`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchAdminShopDetail(shopId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function patchAdminShop(shopId, body) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function patchAdminShopAccountStatus(shopId, status) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/account-status`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ status }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function deleteAdminShop(shopId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}`, {
    method: "DELETE",
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchAdminShopDashboard() {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/dashboard`, {
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function approveAdminShop(shopId, body = {}) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/approve`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function rejectAdminShop(shopId, reason = "") {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/reject`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function patchAdminShopAccess(shopId, body) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/access`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function startAdminShopTrial(shopId, trialDays = 14) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/trial/start`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...getAdminAuthHeaders() },
    body: JSON.stringify({ trialDays }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function endAdminShopTrial(shopId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/admin/shops/${encodeURIComponent(String(shopId))}/trial/end`, {
    method: "POST",
    headers: { Accept: "application/json", ...getAdminAuthHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}
