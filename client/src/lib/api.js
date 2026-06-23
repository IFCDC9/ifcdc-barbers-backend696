import { API_BASE_URL, PRODUCTION_API_ORIGIN } from "../config/api.js"

export { API_BASE_URL }

/**
 * API origin:
 * - **Dev (default):** empty string → same-origin paths `/api/...`, `/auth/...` so the Vite proxy
 *   forwards to the backend (no cross-origin fetch; works from localhost and LAN :5173).
 * - **Prod / preview:** `VITE_API_BASE` or `VITE_API_URL`, else `API_BASE_URL` from `config/api.js`.
 * Set `VITE_USE_ABSOLUTE_API=true` in dev to force a full backend URL (e.g. debugging).
 */
function resolveApiOrigin() {
  const env = typeof import.meta !== "undefined" ? import.meta.env : {}
  const forceAbsolute =
    String(env.VITE_USE_ABSOLUTE_API || "").trim().toLowerCase() === "true"
  if (env.DEV && !forceAbsolute) {
    return ""
  }
  const fromEnv =
    env?.VITE_API_BASE != null
      ? String(env.VITE_API_BASE).trim()
      : env?.VITE_API_URL != null
        ? String(env.VITE_API_URL).trim()
        : ""
  if (fromEnv) return fromEnv.replace(/\/$/, "")
  // Split-host production (ifcdcbarbersapp.com static → backend696 API).
  if (typeof window !== "undefined" && window.location?.origin) {
    const host = String(window.location.hostname || "").toLowerCase()
    if (
      env.PROD &&
      (host === "ifcdcbarbersapp.com" ||
        host.endsWith(".ifcdcbarbersapp.com") ||
        host.includes("ifcdc-barbers-frontend"))
    ) {
      return PRODUCTION_API_ORIGIN
    }
  }
  const base = API_BASE_URL
  return base.replace(/\/$/, "")
}

export const FORCE_API_ORIGIN = resolveApiOrigin()

console.log(
  "[ifcdc] API base:",
  FORCE_API_ORIGIN || "(same-origin → Vite proxy in dev)",
)

export function getApiBase() {
  return FORCE_API_ORIGIN
}

export function apiUrl(path) {
  const p = String(path || "");
  const normalized = p.startsWith("/") ? p : `/${p}`;
  return `${FORCE_API_ORIGIN}${normalized}`;
}

/** Prevents hung UI when the backend is down or unreachable (default 12s). */
const DEFAULT_FETCH_TIMEOUT_MS = 12000;

/**
 * `fetch` with AbortController timeout. Pass `timeoutMs` on `init` to override (stripped before fetch).
 */
export function fetchWithTimeout(url, init = {}) {
  const ms =
    typeof init.timeoutMs === "number" && init.timeoutMs > 0
      ? init.timeoutMs
      : DEFAULT_FETCH_TIMEOUT_MS;
  const { timeoutMs: _omit, ...rest } = init;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...rest, signal: controller.signal }).finally(() => clearTimeout(id));
}

function networkErrorHint() {
  if (FORCE_API_ORIGIN) {
    return `Cannot reach ${FORCE_API_ORIGIN}. Ensure the API is running and reachable (e.g. 0.0.0.0:5050).`
  }
  const env = typeof import.meta !== "undefined" ? import.meta.env : {}
  if (env.DEV) {
    return (
      "In dev, requests go to /api on this origin and Vite proxies them to your backend. " +
      "From the repo root run: npm run dev (API on :5050) and npm run dev --prefix client, or npm run dev:all. " +
      "If the API is on another host/port, set VITE_DEV_API_PROXY_TARGET in client/.env (or VITE_API_BASE) and restart Vite."
    )
  }
  return "Check VITE_API_BASE / VITE_API_URL and that the deployed API is up."
}

function wrapNetworkError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || msg.includes("aborted")) {
    return new Error(
      `Request timed out (${DEFAULT_FETCH_TIMEOUT_MS}ms) — ${networkErrorHint()}`,
    )
  }
  if (
    name === "TypeError" ||
    msg.includes("Failed to fetch") ||
    msg.includes("fetch") ||
    msg.includes("NetworkError") ||
    msg.includes("Load failed")
  ) {
    return new Error(`Network error — ${networkErrorHint()}`)
  }
  return err instanceof Error ? err : new Error(msg);
}

async function readJsonBody(r) {
  const text = await r.text();
  if (!text.trim()) {
    return { _emptyBody: true };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { _nonJson: true, _preview: text.slice(0, 160) };
  }
}

/** Prefer human-readable fields many routes use (detail, message, error, …). */
function pickHttpErrorMessage(j) {
  if (!j || typeof j !== "object" || j._nonJson || j._emptyBody) return null
  const asStr = (v) => {
    if (v == null) return null
    if (typeof v === "string") return v.trim() || null
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    return null
  }
  const d = asStr(j.detail)
  if (d) return d
  const m = asStr(j.message)
  if (m) return m
  const e = j.error
  if (typeof e === "string" && e.trim()) return e.trim()
  if (e != null && typeof e === "object") {
    try {
      const s = JSON.stringify(e)
      if (s && s !== "{}") return s
    } catch {
      /* ignore */
    }
  }
  if (Array.isArray(j.errors) && j.errors.length) {
    const first = j.errors[0]
    const em = typeof first === "string" ? first : first?.message
    if (em) return String(em)
  }
  const reason = asStr(j.reason)
  if (reason) return reason
  return null
}

function describeFailedRequest(r) {
  const bits = [`HTTP ${r.status}`]
  if (r.statusText) bits.push(String(r.statusText).trim())
  try {
    if (r.url) bits.push(String(r.url))
  } catch {
    /* ignore */
  }
  return bits.filter(Boolean).join(" · ")
}

function throwHttpError(r, j) {
  if (j && j._emptyBody) {
    throw new Error(
      `${describeFailedRequest(r)} — empty response body. Is the API running on :5050? In dev, set VITE_API_URL (e.g. http://192.168.1.136:5050) in client/.env and restart Vite.`,
    )
  }

  const picked = pickHttpErrorMessage(j)
  if (picked) throw new Error(picked)

  if (j && !j._nonJson && typeof j === "object" && Object.keys(j).length > 0) {
    const brief = JSON.stringify(j)
    if (brief && brief !== "{}") {
      throw new Error(brief.length > 400 ? `${brief.slice(0, 400)}…` : brief)
    }
  }

  if (j?._nonJson) {
    const prev = j._preview || ""
    throw new Error(
      r.status >= 500
        ? `Server error (${r.status}). Non-JSON body: ${prev || "(empty)"}`
        : `HTTP ${r.status}. Non-JSON body: ${prev || "(empty)"}`,
    )
  }

  if (r.status === 404) {
    throw new Error(
      j?._nonJson
        ? "API returned 404 (page was HTML, not JSON). In dev, use the Vite proxy (same-origin); in prod, check VITE_API_BASE."
        : `HTTP 404 — no API route at ${FORCE_API_ORIGIN || "origin"}.`,
    )
  }

  throw new Error(
    `${describeFailedRequest(r)} — no parseable error JSON. If this persists, check the API terminal logs.`,
  )
}

export async function apiGet(path, init = {}) {
  const { headers: extraHeaders = {}, timeoutMs, ...rest } = init;
  let r;
  try {
    r = await fetchWithTimeout(apiUrl(path), {
      method: "GET",
      headers: { Accept: "application/json", ...extraHeaders },
      ...(timeoutMs ? { timeoutMs } : {}),
      ...rest,
    });
  } catch (e) {
    console.error("[ifcdc] apiGet failed:", path, e);
    throw wrapNetworkError(e);
  }
  const j = await readJsonBody(r);
  if (!r.ok) throwHttpError(r, j);
  return j;
}

/**
 * GET that never throws — returns `null` on network/HTTP/parse failure (use fallbacks in UI).
 */
export async function safeApiGet(path) {
  try {
    return await apiGet(path);
  } catch (e) {
    console.error("API ERROR:", e);
    return null;
  }
}

/**
 * Raw fetch helper — returns parsed JSON or `null`. Accepts absolute URL or API path (uses `apiUrl`).
 */
export async function safeFetch(pathOrUrl) {
  const url =
    typeof pathOrUrl === "string" && /^https?:\/\//i.test(pathOrUrl.trim())
      ? pathOrUrl.trim()
      : apiUrl(pathOrUrl);
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error("API failed");
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err) {
    console.error("API ERROR:", err);
    return null;
  }
}

export async function apiPost(path, body, headers = {}) {
  let r;
  try {
    r = await fetchWithTimeout(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    console.error("[ifcdc] apiPost failed:", path, e);
    throw wrapNetworkError(e);
  }
  const j = await readJsonBody(r);
  if (!r.ok) throwHttpError(r, j);
  return j;
}

export async function apiPut(path, body, headers = {}) {
  let r;
  try {
    r = await fetchWithTimeout(apiUrl(path), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    console.error("[ifcdc] apiPut failed:", path, e);
    throw wrapNetworkError(e);
  }
  const j = await readJsonBody(r);
  if (!r.ok) throwHttpError(r, j);
  return j;
}

export async function apiDelete(path, headers = {}) {
  let r;
  try {
    r = await fetchWithTimeout(apiUrl(path), { method: "DELETE", headers });
  } catch (e) {
    console.error("[ifcdc] apiDelete failed:", path, e);
    throw wrapNetworkError(e);
  }
  const j = await readJsonBody(r);
  if (!r.ok) throwHttpError(r, j);
  return j;
}
