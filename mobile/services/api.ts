import { apiFullUrl } from "../constants/config";
import { getAuthToken, setAuthToken } from "./authService";
import { reportConnectionFailure, reportConnectionRecovered } from "./connectionAlerts";
import { refreshAuthSession, SessionExpiredError } from "./sessionApi";

type ApiFetchOptions = RequestInit & { auth?: boolean; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 25_000;

function shouldAlertOnHttpStatus(status: number): boolean {
  return status >= 500 || status === 0;
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
  const error = String(body?.error || "").trim();
  if (message) return message;
  if (error) return error;
  return `${res.status} ${res.statusText}`;
}

export async function apiFetch(path: string, options: ApiFetchOptions = {}) {
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
    if (refreshed?.token) {
      await setAuthToken(refreshed.token);
      try {
        res = await doFetch(refreshed.token);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`[api] network error ${url} — ${message}`);
      }
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
    throw new Error(msg);
  }

  reportConnectionRecovered();
  return res;
}
