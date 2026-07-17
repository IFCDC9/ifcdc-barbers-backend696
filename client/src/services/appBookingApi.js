/**
 * Mobile booking APIs — same endpoints as mobile/services/bookingPayPalApi.js
 */
import { getApiOrigin } from "./api.js";
import { DEFAULT_BOOKING_SERVICES } from "../lib/defaultBookingServices.js";
import { enrichBookingServicesWithPublishedStyles } from "../lib/bookingServiceImages.js";
import { getStoredToken } from "../lib/authHeaders.js";

const BOOKING_FETCH_TIMEOUT_MS = 25_000;
export const SERVICES_FETCH_TIMEOUT_MS = 12_000;
const FINALIZE_RETRY_ATTEMPTS = 4;
const FINALIZE_RETRY_BASE_MS = 1200;

function apiUrl(path) {
  const origin = getApiOrigin().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

async function bookingFetch(url, init = {}) {
  const timeoutMs = init.timeoutMs ?? BOOKING_FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { timeoutMs: _drop, ...rest } = init;
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function buildServicesQuery({ barberName, barberId }) {
  const q = new URLSearchParams();
  if (barberId != null && String(barberId).trim()) {
    q.set("barberId", String(barberId));
    q.set("barber_id", String(barberId));
  }
  if (barberName) q.set("barberName", barberName);
  return q;
}

function localFallbackResult(barberId) {
  return {
    services: DEFAULT_BOOKING_SERVICES,
    barberId,
    fallbackUsed: true,
    usedLocalFallback: true,
    source: "local",
  };
}

async function requestServicesFromUrl(url, timeoutMs) {
  let res;
  try {
    res = await bookingFetch(url, { headers: { Accept: "application/json" }, timeoutMs });
  } catch (e) {
    const err = new Error(e?.name === "AbortError" ? "timeout" : e?.message || String(e));
    err.status = e?.name === "AbortError" ? "timeout" : "network";
    err.url = url;
    throw err;
  }
  const json = await parseJson(res);
  if (!res.ok) {
    const err = new Error(String(json.error || json.message || `HTTP ${res.status}`));
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return {
    services: Array.isArray(json.services) ? json.services : [],
    barberId: json.barberId,
    fallbackUsed: Boolean(json.fallbackUsed),
    url,
    status: res.status,
  };
}

export async function fetchBookingServices({ barberName, barberId }) {
  const deadline = Date.now() + SERVICES_FETCH_TIMEOUT_MS;
  const q = buildServicesQuery({ barberName, barberId }).toString();
  const urls = [
    apiUrl(`/api/app-bookings/services?${q}`),
    apiUrl(`/api/barber/services?${q}`),
  ];

  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return localFallbackResult(barberId);
    try {
      const result = await requestServicesFromUrl(url, Math.max(800, remaining));
      if (!result.services.length) continue;
      const enriched = await enrichBookingServicesWithPublishedStyles(
        result.services,
        { barberId: result.barberId ?? barberId, barberName },
        bookingFetch,
        Math.max(2000, remaining),
      );
      return {
        services: enriched,
        barberId: result.barberId ?? barberId,
        fallbackUsed: result.fallbackUsed,
        usedLocalFallback: false,
        source: "api",
      };
    } catch {
      /* try next URL */
    }
  }
  return localFallbackResult(barberId);
}

export async function pingBookingApi() {
  const primary = apiUrl("/api/app-bookings/health");
  let res = await bookingFetch(primary, { method: "GET", headers: { Accept: "application/json" } });
  if (res.status === 404) {
    res = await bookingFetch(apiUrl("/api/health"), { method: "GET", headers: { Accept: "application/json" } });
  }
  const json = await parseJson(res);
  return { ok: res.ok, status: res.status, url: res.url, body: json };
}

export async function fetchBarbersList(providerType) {
  const q = new URLSearchParams();
  if (providerType) q.set("providerType", String(providerType));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const url = apiUrl(`/api/app-bookings/barbers${suffix}`);
  let res;
  try {
    res = await bookingFetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    const err = new Error(e?.name === "AbortError" ? "Request timed out" : e?.message || String(e));
    err.status = e?.name === "AbortError" ? "timeout" : "network";
    err.url = url;
    throw err;
  }
  const json = await parseJson(res);
  if (!res.ok) {
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return Array.isArray(json) ? json : Array.isArray(json.barbers) ? json.barbers : [];
}

export async function fetchAvailableSlots({ barberName, barberId, dateLabel, durationMinutes }) {
  const q = new URLSearchParams();
  if (barberId != null && String(barberId).trim()) q.set("barberId", String(barberId));
  if (barberName) q.set("barberName", barberName);
  if (dateLabel) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateLabel))) q.set("date", String(dateLabel));
    else q.set("dateLabel", dateLabel);
  }
  if (durationMinutes != null && Number(durationMinutes) > 0) {
    q.set("durationMinutes", String(Math.round(Number(durationMinutes))));
  }
  const url = apiUrl(`/api/app-bookings/available-slots?${q.toString()}`);
  const res = await bookingFetch(url, { headers: { Accept: "application/json" } });
  const json = await parseJson(res);
  if (!res.ok) {
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return {
    slots: Array.isArray(json.slots) ? json.slots : [],
    timezone: json.timezone,
    intervalMinutes: json.intervalMinutes,
    date: json.date,
    barberId: json.barberId,
    usedFallback: json.usedFallback,
    reasonIfEmpty: json.reasonIfEmpty || null,
    unavailability: json.unavailability || null,
  };
}

export async function startAppBookingCheckout(payload) {
  const url = apiUrl("/api/app-bookings/start");
  const token = getStoredToken();
  const res = await bookingFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${String(token).replace(/^Bearer\s+/i, "")}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const json = await parseJson(res);
  if (!res.ok || json.success === false) {
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.code = json.error;
    err.details = json;
    err.status = res.status;
    err.url = url;
    throw err;
  }
  if (!json.orderId || !json.approveUrl) {
    const err = new Error("Server did not return PayPal orderId and approveUrl.");
    err.code = "missing_paypal_order";
    err.details = json;
    throw err;
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableFinalizeError(err) {
  const status = Number(err?.status);
  if (status >= 502 && status <= 504) return true;
  if (err?.name === "AbortError") return true;
  const code = String(err?.code || "").toLowerCase();
  return code === "finalize_failed" || code === "network" || status === 0;
}

async function finalizeOnce(orderID) {
  const url = apiUrl("/api/app-bookings/finalize");
  const res = await bookingFetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ orderID }),
    timeoutMs: 45_000,
  });
  const json = await parseJson(res);

  if (json?.paymentCaptured === true && json?.booking?.id) return json;

  if (!res.ok || json.verified !== true) {
    if (json?.paymentCaptured === true) {
      const err = new Error(
        json.message ||
          "PayPal payment was received. Your booking is being confirmed — check your email or contact IFCDC support.",
      );
      err.paymentCaptured = true;
      err.details = json;
      throw err;
    }
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.code = json.error;
    err.details = json;
    err.status = res.status;
    throw err;
  }

  if (!json.booking?.id) {
    throw new Error("Server did not return a confirmed booking.");
  }
  return json;
}

export async function finalizeAppBookingCheckout(orderID) {
  let lastErr;
  for (let attempt = 1; attempt <= FINALIZE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await finalizeOnce(orderID);
    } catch (err) {
      lastErr = err;
      if (err?.paymentCaptured === true) throw err;
      if (attempt < FINALIZE_RETRY_ATTEMPTS && isRetryableFinalizeError(err)) {
        await sleep(FINALIZE_RETRY_BASE_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
