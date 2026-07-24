import { apiFullUrl } from "../constants/config";
import { getAuthToken, setAuthToken } from "./authService";
import { reportConnectionFailure, reportConnectionRecovered } from "./connectionAlerts";
import { refreshAuthSession, SessionExpiredError } from "./sessionApi";

type ApiFetchOptions = RequestInit & { auth?: boolean; timeoutMs?: number; retries?: number };

const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAlertOnHttpStatus(status: number): boolean {
  return status >= 500 || status === 0;
}

function isRetryableError(e: unknown, status?: number): boolean {
  if (status != null && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return (
    msg.includes("network error")
    || msg.includes("abort")
    || msg.includes("timeout")
    || msg.includes("502")
    || msg.includes("503")
    || msg.includes("504")
  );
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseApiErrorDetail(res: Response, body: Record<string, unknown>): string {
  const message = String(body?.message || "").trim();
  const detail = String(body?.detail || "").trim();
  const error = String(body?.error || "").trim();
  const code = String(body?.code || "").trim();
  if (message && detail && detail !== message) return `${message} (${detail})`;
  if (message) return code && !message.includes(code) ? `${message} [${code}]` : message;
  if (detail) return detail;
  if (error) return error;
  return `${res.status} ${res.statusText}`;
}

async function apiFetchOnce(path: string, options: ApiFetchOptions = {}) {
  const url = path.startsWith("http") ? path : apiFullUrl(path);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  console.log("[apiFetch]", options.method || "GET", url);
  const headers = new Headers(options.headers || {});

  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  const auth = options.auth !== false;
  let token: string | null = null;
  if (auth) {
    try {
      token = await getAuthToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    } catch (e) {
      console.log("[api] getAuthToken failed (non-fatal):", e instanceof Error ? e.message : String(e));
    }
  }

  const doFetch = async (bearer: string | null) => {
    const h = new Headers(headers);
    if (auth && bearer) h.set("Authorization", `Bearer ${bearer}`);
    return fetchWithTimeout(url, { ...options, headers: h }, timeoutMs);
  };

  let res: Response;
  try {
    res = await doFetch(token);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log("[api] fetch threw", url, message);
    reportConnectionFailure({ kind: "network", url, message });
    throw new Error(`[api] network error ${url} — ${message}`);
  }

  if (res.status === 401 && auth && token) {
    const refreshed = await refreshAuthSession(token);
    if (refreshed.ok) {
      await setAuthToken(refreshed.token);
      try {
        res = await doFetch(refreshed.token);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`[api] network error ${url} — ${message}`);
      }
    } else if (refreshed.reason === "invalid") {
      throw new SessionExpiredError("Invalid or expired token");
    }
  }

  if (!res.ok) {
    let detail = "";
    let body: Record<string, unknown> = {};
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        body = (await res.json()) as Record<string, unknown>;
        detail = parseApiErrorDetail(res, body);
      } else {
        detail = await res.text();
      }
    } catch {
      // ignore
    }

    const msg = `[api] ${res.status} ${res.statusText} ${url}${detail ? ` — ${detail}` : ""}`;
    console.log(msg);
    if (shouldAlertOnHttpStatus(res.status)) {
      reportConnectionFailure({ kind: "http", url, status: res.status, message: detail || res.statusText });
    }
    if (res.status === 401) {
      throw new SessionExpiredError(detail || "Session expired. Sign in again.");
    }
    const err = new Error(msg);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  reportConnectionRecovered();
  return res;
}

export async function apiFetch(path: string, options: ApiFetchOptions = {}) {
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await apiFetchOnce(path, options);
    } catch (e) {
      lastError = e;
      if (e instanceof SessionExpiredError) throw e;
      const status = (e as Error & { status?: number })?.status;
      if (!isRetryableError(e, status) || attempt >= maxRetries) throw e;
      const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
      console.log(`[apiFetch] retry ${attempt + 1}/${maxRetries} for ${path} in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}
