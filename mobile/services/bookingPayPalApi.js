import { API_URL, apiFullUrl } from "../constants/config";
import { getAuthToken } from "./authService";
import { fetchWithTimeout } from "../auth/authSessionApi";
import { DEFAULT_BOOKING_SERVICES } from "../lib/defaultBookingServices.js";
import {
  enrichBookingServicesWithPublishedStyles,
  normalizeBookingService,
} from "../utils/bookingServiceImages.js";

const BOOKING_FETCH_TIMEOUT_MS = 25_000;
/** Service menu — allow cold Render wake; avoid offline emoji-only fallback. */
export const SERVICES_FETCH_TIMEOUT_MS = 12_000;

const FINALIZE_RETRY_ATTEMPTS = 4;
const FINALIZE_RETRY_BASE_MS = 1200;

async function bookingFetch(url, init = {}) {
  const timeoutMs = init.timeoutMs ?? BOOKING_FETCH_TIMEOUT_MS;
  const { timeoutMs: _drop, ...rest } = init;
  return fetchWithTimeout(url, { ...rest, timeoutMs });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFinalizeError(err) {
  const status = Number(err?.status);
  if (status >= 502 && status <= 504) return true;
  if (err?.name === "AbortError") return true;
  const code = String(err?.code || "").toUpperCase();
  // Never retry payer-action / unprocessable capture errors — same Order ID would fail again.
  if (code.includes("UNPROCESSABLE") || code === "ORDER_NOT_APPROVED" || status === 422) return false;
  return code === "FINALIZE_FAILED" || code === "NETWORK" || status === 0;
}

let loggedApiEnvOnce = false;

function logApiEnvOnce() {
  if (loggedApiEnvOnce) return;
  loggedApiEnvOnce = true;
  const base = String(API_URL || "").replace(/\/+$/, "");
  console.log("[IFCDC API] resolved base URL:", base || "(empty)");
  console.log("EXPO_PUBLIC_API_URL:", process.env.EXPO_PUBLIC_API_URL ?? "(unset)");
  console.log("EXPO_PUBLIC_BACKEND_URL:", process.env.EXPO_PUBLIC_BACKEND_URL ?? "(unset)");
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
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

function logServicesEvent(kind, { barberId, url, status, count, fallbackUsed }) {
  console.log(
    `[services] ${kind} barberId=${barberId ?? "—"} url=${url ?? "—"} status=${status ?? "—"} count=${count ?? 0} fallbackUsed=${Boolean(fallbackUsed)}`,
  );
}

function localFallbackResult(barberId, reason) {
  logServicesEvent("failed", {
    barberId,
    url: "local-fallback",
    status: reason,
    count: DEFAULT_BOOKING_SERVICES.length,
    fallbackUsed: true,
  });
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
    res = await bookingFetch(url, {
      headers: { Accept: "application/json" },
      timeoutMs,
    });
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError";
    const err = new Error(isTimeout ? "timeout" : e instanceof Error ? e.message : String(e));
    err.status = isTimeout ? "timeout" : "network";
    err.url = url;
    throw err;
  }

  const json = await parseJson(res);
  if (!res.ok) {
    const err = new Error(String(json.error || json.message || `HTTP ${res.status}`));
    err.status = res.status;
    err.code = json.error;
    err.url = url;
    throw err;
  }

  const services = (Array.isArray(json.services) ? json.services : []).map(normalizeBookingService);
  return {
    services,
    barberId: json.barberId,
    fallbackUsed: Boolean(json.fallbackUsed),
    url,
    status: res.status,
  };
}

function primaryServiceUrls({ barberName, barberId }) {
  const q = buildServicesQuery({ barberName, barberId }).toString();
  return [
    apiFullUrl(`/api/app-bookings/services?${q}`),
    apiFullUrl(`/api/barber/services?${q}`),
  ];
}

function nameOnlyServiceUrls(barberName) {
  if (!barberName) return [];
  const q = buildServicesQuery({ barberName, barberId: null }).toString();
  return [
    apiFullUrl(`/api/app-bookings/services?${q}`),
    apiFullUrl(`/api/barber/services?${q}`),
  ];
}

/**
 * GET /api/barber/services — never throws; returns API services or local fallback within 5s.
 * @returns {Promise<{ services: object[], barberId?: string|number, fallbackUsed: boolean, usedLocalFallback?: boolean, source: string }>}
 */
export async function fetchBookingServices({ barberName, barberId }) {
  logApiEnvOnce();
  const barberIdLabel = barberId != null && String(barberId).trim() ? String(barberId) : "—";
  const deadline = Date.now() + SERVICES_FETCH_TIMEOUT_MS;
  const urls = [...new Set([...primaryServiceUrls({ barberName, barberId }), ...nameOnlyServiceUrls(barberName)])];

  let lastStatus = "—";
  let lastUrl = urls[0] || "—";

  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logServicesEvent("timeout", {
        barberId: barberIdLabel,
        url: lastUrl,
        status: "deadline",
        count: 0,
        fallbackUsed: true,
      });
      return localFallbackResult(barberId, "deadline");
    }

    lastUrl = url;
    try {
      const result = await requestServicesFromUrl(url, Math.max(800, remaining));
      if (!result.services.length) {
        lastStatus = "empty";
        logServicesEvent("failed", {
          barberId: barberIdLabel,
          url,
          status: "empty",
          count: 0,
          fallbackUsed: false,
        });
        continue;
      }
      const enriched = await enrichBookingServicesWithPublishedStyles(
        result.services,
        { barberId: result.barberId ?? barberId, barberName },
        bookingFetch,
        Math.max(2000, deadline - Date.now()),
      );
      const withPhotos = enriched.filter((s) => String(s.image_url || "").trim()).length;
      logServicesEvent("success", {
        barberId: result.barberId ?? barberIdLabel,
        url,
        status: result.status ?? 200,
        count: enriched.length,
        fallbackUsed: result.fallbackUsed,
      });
      console.log(
        `[services] photos barberId=${result.barberId ?? barberIdLabel} withImage=${withPhotos}/${enriched.length}`,
      );
      return {
        services: enriched,
        barberId: result.barberId ?? barberId,
        fallbackUsed: result.fallbackUsed,
        usedLocalFallback: false,
        source: "api",
      };
    } catch (e) {
      const status = e?.status ?? (e?.message === "timeout" ? "timeout" : "error");
      lastStatus = status;
      const kind = status === "timeout" || status === "deadline" ? "timeout" : "failed";
      logServicesEvent(kind, {
        barberId: barberIdLabel,
        url,
        status,
        count: 0,
        fallbackUsed: false,
      });
    }
  }

  return localFallbackResult(barberId, lastStatus);
}

/**
 * GET /api/app-bookings/health (primary) or GET /api/health (fallback).
 */
export async function pingBookingApi() {
  logApiEnvOnce();
  const primary = apiFullUrl("/api/app-bookings/health");
  console.log("[IFCDC] health check URL:", primary);
  let res = await bookingFetch(primary, { method: "GET", headers: { Accept: "application/json" } });
  if (res.status === 404) {
    const fallback = apiFullUrl("/api/health");
    console.log("[IFCDC] app-bookings/health 404 — trying:", fallback);
    res = await bookingFetch(fallback, { method: "GET", headers: { Accept: "application/json" } });
  }
  const json = await parseJson(res);
  return { ok: res.ok, status: res.status, url: res.url, body: json };
}

/**
 * Server creates pending Postgres booking + PayPal order (server-only totals).
 * @param {{ barberName?: string, barberId?: number|string, barberUuid?: string, dateLabel: string, timeLabel: string, redirectUri: string, cancelUri?: string, userId?: string, serviceId: number|string, serviceName?: string }} payload
 */
export async function startAppBookingCheckout(payload) {
  logApiEnvOnce();
  const url = apiFullUrl("/api/app-bookings/start");
  console.log("BOOKING CHECKOUT URL:", url);
  console.log("CHECKOUT INIT payload:", {
    barberName: payload?.barberName,
    barberId: payload?.barberId,
    barberUuid: payload?.barberUuid,
    serviceId: payload?.serviceId,
    dateLabel: payload?.dateLabel,
    timeLabel: payload?.timeLabel,
    redirectUri: payload?.redirectUri,
    customerEmail: payload?.customerEmail ? "(set)" : "(missing)",
  });
  console.log("PAYPAL CLIENT (mobile env):", process.env.EXPO_PUBLIC_PAYPAL_CLIENT_ID ?? "(unset — server creates order)");
  console.log("PAYPAL ENV (mobile):", process.env.EXPO_PUBLIC_PAYPAL_ENV ?? "(unset)");

  try {
    const token = await getAuthToken().catch(() => null);
    const res = await bookingFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const json = await parseJson(res);
    console.log("CHECKOUT RESPONSE:", {
      status: res.status,
      ok: res.ok,
      success: json?.success,
      error: json?.error,
      message: json?.message,
      orderId: json?.orderId,
      hasApproveUrl: Boolean(json?.approveUrl),
      paypal: json?.paypal,
    });
    if (!res.ok || json.success === false) {
      const msg =
        json.message ||
        json.error ||
        (typeof json.raw === "string" && json.raw.slice(0, 200)) ||
        `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = json.error;
      err.details = json;
      err.status = res.status;
      err.url = url;
      throw err;
    }
    if (!json.orderId || !json.approveUrl) {
      console.error("CHECKOUT INIT FAILED: missing orderId or approveUrl", json);
      const err = new Error("Server did not return PayPal orderId and approveUrl.");
      err.code = "missing_paypal_order";
      err.details = json;
      err.status = res.status;
      err.url = url;
      throw err;
    }
    console.log("[paypal] checkout start ok", {
      orderId: json.orderId,
      approveUrl: String(json.approveUrl).slice(0, 120),
      total: json.total,
      bookingId: json.bookingId,
    });
    return json;
  } catch (err) {
    console.error("CHECKOUT INIT FAILED:", err);
    throw err;
  }
}

/**
 * Single finalize attempt — server is source of truth for payment + booking.
 * @param {string} orderID
 */
async function finalizeAppBookingCheckoutOnce(orderID) {
  const url = apiFullUrl("/api/app-bookings/finalize");
  const res = await bookingFetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ orderID }),
    timeoutMs: 45_000,
  });
  const json = await parseJson(res);

  console.log("[IFCDC] FINALIZE RESPONSE:", {
    status: res.status,
    verified: json?.verified,
    paymentCaptured: json?.paymentCaptured,
    bookingId: json?.bookingId ?? json?.booking?.id,
    captureId: json?.captureId,
    emailSent: json?.emailSent,
    needsReview: json?.needsReview,
    error: json?.error,
  });

  if (json?.paymentCaptured === true && json?.booking?.id) {
    return json;
  }

  if (!res.ok || json.verified !== true) {
    if (json?.paymentCaptured === true) {
      const err = new Error(
        json.message ||
          "PayPal payment was received. Your booking is being confirmed — check your email or contact IFCDC support.",
      );
      err.code = json.error || "payment_captured_booking_pending";
      err.details = json;
      err.status = res.status;
      err.url = url;
      err.paymentCaptured = true;
      throw err;
    }
    const msg = json.message || json.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.error;
    err.details = json;
    err.status = res.status;
    err.url = url;
    throw err;
  }

  if (!json.booking?.id) {
    const err = new Error("Server did not return a confirmed booking.");
    err.code = "booking_missing";
    err.details = json;
    err.status = res.status;
    err.url = url;
    throw err;
  }

  return json;
}

/**
 * Server verifies PayPal capture and finalizes booking in Postgres (retries transient failures).
 * @param {string} orderID
 */
export async function finalizeAppBookingCheckout(orderID) {
  logApiEnvOnce();
  const url = apiFullUrl("/api/app-bookings/finalize");
  console.log("[IFCDC] BOOKING FINALIZE POST:", url, { orderID });

  let lastErr;
  for (let attempt = 1; attempt <= FINALIZE_RETRY_ATTEMPTS; attempt++) {
    try {
      const json = await finalizeAppBookingCheckoutOnce(orderID);
      if (json.needsReview) {
        console.warn("[IFCDC] finalize needsReview:", json.reviewReason);
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (err?.paymentCaptured === true) {
        throw err;
      }
      if (attempt < FINALIZE_RETRY_ATTEMPTS && isRetryableFinalizeError(err)) {
        const delay = FINALIZE_RETRY_BASE_MS * attempt;
        console.warn(`[IFCDC] finalize attempt ${attempt} failed — retry in ${delay}ms`, err?.message);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Available 30-minute slots for a barber on a date (server-generated from schedule).
 * @returns {Promise<{ slots: { time: string, available: boolean, reason?: string }[], timezone?: string, intervalMinutes?: number }>}
 */
export async function fetchAvailableSlots({ barberName, barberId, dateLabel, durationMinutes }) {
  logApiEnvOnce();
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
  const url = apiFullUrl(`/api/app-bookings/available-slots?${q.toString()}`);
  console.log("[IFCDC] AVAILABLE SLOTS GET:", url);

  const res = await bookingFetch(url, {
    headers: { Accept: "application/json" },
  });
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

/**
 * Paid slots for UI (Postgres source of truth).
 * @deprecated Prefer fetchAvailableSlots
 */
export async function fetchOccupiedSlots({ barberName, dateLabel }) {
  logApiEnvOnce();
  const q = new URLSearchParams({ barberName, dateLabel });
  const url = apiFullUrl(`/api/app-bookings/occupied-slots?${q.toString()}`);
  console.log("[IFCDC] OCCUPIED SLOTS GET:", url);

  const res = await bookingFetch(url, {
    headers: { Accept: "application/json" },
  });
  const json = await parseJson(res);
  if (!res.ok) {
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return Array.isArray(json.times) ? json.times : [];
}

/**
 * GET /api/app-bookings/barbers — Postgres bookable barbers (checkout source of truth).
 */
export async function fetchBarbersList(providerType) {
  logApiEnvOnce();
  const BARBERS_FETCH_TIMEOUT_MS = 55_000;
  const BARBERS_FETCH_ATTEMPTS = 3;
  const q = new URLSearchParams();
  q.set("channel", "mobile");
  if (providerType && !["all", "*"].includes(String(providerType).trim().toLowerCase())) {
    q.set("providerType", String(providerType));
  }
  const url = apiFullUrl(`/api/app-bookings/barbers?${q.toString()}`);
  console.log("BOOKING API:", url);
  console.log("[IFCDC] BARBERS GET:", url);

  // Best-effort wake for sleeping Render dynos.
  try {
    await bookingFetch(apiFullUrl("/api/health"), {
      headers: { Accept: "application/json" },
      timeoutMs: BARBERS_FETCH_TIMEOUT_MS,
    });
  } catch {
    /* continue to real request */
  }

  let lastErr;
  for (let attempt = 1; attempt <= BARBERS_FETCH_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await bookingFetch(url, {
        headers: { Accept: "application/json" },
        timeoutMs: BARBERS_FETCH_TIMEOUT_MS,
      });
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "AbortError";
      const message = e instanceof Error ? e.message : String(e);
      console.warn("BOOKING RESPONSE: network", { url, error: message, timeout: isTimeout, attempt });
      lastErr = new Error(isTimeout ? "Request timed out" : `Network error: ${message}`);
      lastErr.status = isTimeout ? "timeout" : "network";
      lastErr.url = url;
      if (attempt < BARBERS_FETCH_ATTEMPTS) {
        await sleep(800 * attempt);
        continue;
      }
      throw lastErr;
    }
    console.log("BOOKING RESPONSE:", res.status);
    const json = await parseJson(res);
    console.log(
      "BOOKING DATA:",
      Array.isArray(json)
        ? `array(${json.length})`
        : json && typeof json === "object"
          ? Object.keys(json).join(",")
          : String(json),
    );
    if (!res.ok) {
      lastErr = new Error(json.message || json.error || `HTTP ${res.status}`);
      lastErr.status = res.status;
      lastErr.url = url;
      if (res.status >= 500 && attempt < BARBERS_FETCH_ATTEMPTS) {
        await sleep(800 * attempt);
        continue;
      }
      throw lastErr;
    }
    // Accept array body, { barbers }, { providers }, or { data }
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.providers)) return json.providers;
    if (Array.isArray(json?.barbers)) return json.barbers;
    if (Array.isArray(json?.data)) return json.data;
    return [];
  }
  throw lastErr || new Error("Could not load providers.");
}

/** @deprecated Legacy path — use startAppBookingCheckout. */
export function logLegacyPayPalCreateOrderUrl() {
  logApiEnvOnce();
  console.log("[IFCDC] LEGACY (unused) PayPal URL would be:", apiFullUrl("/api/paypal/create-app-booking-order"));
}
