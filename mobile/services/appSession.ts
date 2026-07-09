import { apiFullUrl } from "../constants/config";
import { isJwtExpired } from "../auth/jwtSession";
import { apiFetch } from "./api";
import { getAuthToken, setAuthToken } from "./authService";
import { refreshAuthSession, SessionExpiredError } from "./sessionApi";

let wakePromise: Promise<void> | null = null;
let lastWakeAt = 0;
const WAKE_TTL_MS = 60_000;

/** Ping /health so Render cold starts finish before protected API calls. */
export async function wakeApiIfNeeded(): Promise<void> {
  if (Date.now() - lastWakeAt < WAKE_TTL_MS) return;
  if (!wakePromise) {
    wakePromise = (async () => {
      try {
        await fetch(apiFullUrl("/health"), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        lastWakeAt = Date.now();
      } catch {
        /* non-fatal — protected routes may still succeed */
      } finally {
        wakePromise = null;
      }
    })();
  }
  await wakePromise;
}

/**
 * Return a usable app JWT from SecureStore, refreshing when expired.
 * On network errors during refresh, keeps the cached token so screens can still try.
 */
export async function ensureValidAppToken(): Promise<string> {
  const token = await getAuthToken();
  if (!token) {
    throw new SessionExpiredError("Sign in to continue.");
  }

  if (!isJwtExpired(token, 120)) {
    return token;
  }

  const refreshed = await refreshAuthSession(token);
  if (refreshed.ok) {
    await setAuthToken(refreshed.token);
    return refreshed.token;
  }
  if (refreshed.reason === "invalid") {
    throw new SessionExpiredError();
  }

  return token;
}

type FetchAppJsonOptions = RequestInit & { timeoutMs?: number; retries?: number };

/** Authenticated JSON fetch with wake-up, token ensure, and unified errors. */
export async function fetchAppJson<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  options: FetchAppJsonOptions = {},
): Promise<T> {
  await wakeApiIfNeeded();
  await ensureValidAppToken();

  const res = await apiFetch(path, {
    ...options,
    auth: true,
    timeoutMs: options.timeoutMs ?? 35_000,
    retries: options.retries ?? 1,
  });

  const data = (await res.json().catch(() => ({}))) as T;
  if ((data as { ok?: boolean }).ok === false) {
    const message = String((data as { message?: string }).message || "Request failed");
    throw new Error(message);
  }
  return data;
}
