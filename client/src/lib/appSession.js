/**
 * Web app session helpers — wake cold Render instances and fetch authenticated JSON.
 */
import { apiUrl, fetchWithTimeout, getApiBase, wrapNetworkError } from "./api.js";
import { getStoredToken, persistAuthSession } from "./authHeaders.js";

const WAKE_TTL_MS = 60_000;
let wakePromise = null;
let lastWakeAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ping /health before protected calls so Render finishes cold starts. */
export async function wakeApiIfNeeded() {
  if (Date.now() - lastWakeAt < WAKE_TTL_MS) return;
  if (!wakePromise) {
    wakePromise = (async () => {
      try {
        const origin = getApiBase() || "https://ifcdc-barbers-backend696.onrender.com";
        const paths = ["/health", "/api/health"];
        for (const path of paths) {
          try {
            await fetchWithTimeout(`${origin.replace(/\/$/, "")}${path}`, {
              method: "GET",
              headers: { Accept: "application/json" },
              timeoutMs: 15_000,
            });
            lastWakeAt = Date.now();
            break;
          } catch {
            /* try next probe */
          }
        }
      } catch {
        /* non-fatal */
      } finally {
        wakePromise = null;
      }
    })();
  }
  await wakePromise;
}

function normalizeToken(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  return t.replace(/^Bearer\s+/i, "");
}

let refreshInFlight = null;

async function refreshSession(token) {
  await wakeApiIfNeeded();
  const origin = getApiBase() || "https://ifcdc-barbers-backend696.onrender.com";
  const res = await fetchWithTimeout(`${origin.replace(/\/$/, "")}/api/auth/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${normalizeToken(token)}`,
    },
    timeoutMs: 20_000,
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

async function authenticatedFetchOnce(path, options = {}) {
  await wakeApiIfNeeded();

  const url = path.startsWith("http") ? path : apiUrl(path);
  const timeoutMs = options.timeoutMs ?? 35_000;
  const auth = options.auth !== false;

  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let token = "";
  if (auth) {
    token = normalizeToken(getStoredToken());
    if (!token) {
      const err = new Error("Sign in to continue.");
      err.code = "session_expired";
      throw err;
    }
    headers.set("Authorization", `Bearer ${token}`);
  }

  const doFetch = async (bearer) => {
    const h = new Headers(headers);
    if (auth && bearer) h.set("Authorization", `Bearer ${bearer}`);
    return fetchWithTimeout(url, { ...options, headers: h, timeoutMs });
  };

  let res;
  try {
    res = await doFetch(token);
  } catch (e) {
    throw wrapNetworkError(e);
  }

  if (res.status === 401 && auth && token) {
    try {
      const refreshed = await ensureRefreshed(token);
      if (refreshed?.token) {
        res = await doFetch(refreshed.token);
      }
    } catch (e) {
      if (e?.code === "session_expired") throw e;
      throw wrapNetworkError(e);
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
    const data = await res.clone().json().catch(() => ({}));
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw err;
  }

  return res;
}

/**
 * @param {string} path
 * @param {RequestInit & { timeoutMs?: number, auth?: boolean, retries?: number }} [options]
 */
export async function authenticatedFetch(path, options = {}) {
  const maxRetries = options.retries ?? 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await authenticatedFetchOnce(path, options);
    } catch (e) {
      lastError = e;
      if (e?.code === "session_expired") throw e;
      const retryable =
        e?.retryable === true ||
        String(e?.message || "").toLowerCase().includes("network") ||
        String(e?.message || "").toLowerCase().includes("timed out");
      if (!retryable || attempt >= maxRetries) throw e;
      await sleep(1200 * (attempt + 1));
      await wakeApiIfNeeded();
    }
  }

  throw lastError || new Error("Request failed");
}

export async function authenticatedJson(path, options = {}) {
  const res = await authenticatedFetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (data?.ok === false) {
    const err = new Error(data?.message || data?.error || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

export function hasWebSession() {
  try {
    const token = normalizeToken(getStoredToken());
    const user = JSON.parse(window.localStorage.getItem("user") || "null");
    return Boolean(token && user?.id);
  } catch {
    return false;
  }
}
