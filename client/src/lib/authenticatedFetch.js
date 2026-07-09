/**
 * Authenticated fetch with JWT refresh on 401 — keeps web session in sync with backend.
 */
import { getApiOrigin } from "../services/api.js";
import { getStoredToken, persistAuthSession } from "./authHeaders.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1200;
let refreshInFlight = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToken(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  return t.replace(/^Bearer\s+/i, "");
}

function isRetryableError(e, status) {
  if (status != null && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(e?.message || "").toLowerCase();
  return msg.includes("network") || msg.includes("abort") || msg.includes("timeout") || msg.includes("502") || msg.includes("503");
}

async function refreshSession(token) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/auth/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${normalizeToken(token)}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || "Session expired. Sign in again.");
    err.status = res.status;
    err.code = "session_expired";
    throw err;
  }
  if (data?.token) {
    persistAuthSession({ token: data.token, user: data.user });
  }
  return data;
}

async function ensureRefreshed(token) {
  if (!refreshInFlight) {
    refreshInFlight = refreshSession(token).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function authenticatedFetchOnce(path, options = {}) {
  const origin = getApiOrigin();
  const url = path.startsWith("http") ? path : `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = options.auth !== false;

  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let token = "";
  if (auth) {
    token = normalizeToken(getStoredToken());
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const doFetch = (bearer) => {
    const h = new Headers(headers);
    if (auth && bearer) h.set("Authorization", `Bearer ${bearer}`);
    return fetchWithTimeout(url, { ...options, headers: h }, timeoutMs);
  };

  let res;
  try {
    res = await doFetch(token);
  } catch (e) {
    const message = e?.name === "AbortError" ? "Request timed out" : e?.message || "Network error";
    const err = new Error(message);
    err.retryable = true;
    throw err;
  }

  if (res.status === 401 && auth && token) {
    try {
      const refreshed = await ensureRefreshed(token);
      if (refreshed?.token) {
        res = await doFetch(refreshed.token);
      }
    } catch (e) {
      if (e?.code === "session_expired") throw e;
      throw new Error(e?.message || "Session expired. Sign in again.");
    }
  }

  if (!res.ok && auth && res.status === 401) {
    const data = await res.clone().json().catch(() => ({}));
    const err = new Error(data?.message || "Session expired. Sign in again.");
    err.status = 401;
    err.code = "session_expired";
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw err;
  }

  return res;
}

/**
 * @param {string} path - Absolute URL or `/api/...` path
 * @param {RequestInit & { timeoutMs?: number, auth?: boolean, retries?: number }} [options]
 */
export async function authenticatedFetch(path, options = {}) {
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await authenticatedFetchOnce(path, options);
    } catch (e) {
      lastError = e;
      if (e?.code === "session_expired") throw e;
      const retryable = e?.retryable === true || isRetryableError(e, e?.status);
      if (!retryable || attempt >= maxRetries) throw e;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError || new Error("Request failed");
}

export async function authenticatedJson(path, options = {}) {
  const res = await authenticatedFetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
