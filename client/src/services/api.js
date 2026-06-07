/**
 * API base URL:
 * - **LAN / mobile dev:** set `VITE_API_URL=http://<LAN-IP>:5050` in `client/.env`.
 * - **Production:** leave unset for same-origin `/api/...` when serving static + API together.
 */

import { ADMIN_KEY_STORAGE, getResolvedAdminApiKey } from "../config/adminClient.js";
import { API_BASE_URL, PRODUCTION_API_ORIGIN } from "../config/api.js";
import { resolveStyleImageUrl } from "../lib/styleImageUrl.js";

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
  return raw !== undefined && raw !== null && String(raw).trim() !== "" ? String(raw).replace(/\/$/, "") : "";
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
 * JWT first; otherwise `x-admin-key` from localStorage or `VITE_ADMIN_API_KEY` / dev default (must match server `ADMIN_SECRET`).
 */
function getJwtOrAdminKeyHeaders() {
  try {
    const token = window.localStorage.getItem("token");
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* ignore */
  }
  try {
    const k = window.localStorage.getItem(ADMIN_KEY_STORAGE) || getResolvedAdminApiKey();
    if (k) return { "x-admin-key": k };
  } catch {
    /* ignore */
  }
  return {};
}

export async function getStylesAll() {
  const origin = getApiOrigin();
  const authHeaders = getJwtOrAdminKeyHeaders();
  const hasAuth = Boolean(authHeaders.Authorization || authHeaders["x-admin-key"]);
  const url = hasAuth ? `${origin}/api/styles/manage/all` : `${origin}/api/styles`;
  const res = await fetch(url, { headers: { Accept: "application/json", ...authHeaders } });
  const text = await res.text();
  if (!res.ok) throw new Error(text?.slice(0, 200) || `HTTP ${res.status}`);
  const j = text ? JSON.parse(text) : {};
  return Array.isArray(j?.styles) ? j.styles : [];
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
  const url = `${base}/api/styles`;
  const fd = new FormData();
  if (barberId != null) fd.append("barberId", String(barberId));
  fd.append("title", String(title || ""));
  fd.append("description", String(description || ""));
  fd.append("category", String(category || "other"));
  const p = Number(price);
  if (Number.isFinite(p) && p > 0) fd.append("price", String(p));
  if (file) fd.append("image", file);

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
  return j?.style;
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
    formData.append("styles", f);
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
  fd.append("image", file);
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
