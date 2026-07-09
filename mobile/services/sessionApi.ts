import { apiFullUrl } from "../constants/config";
import { fetchWithTimeout } from "../auth/authSessionApi";
import type { JsonAuth } from "../auth/authSessionApi";

export class SessionExpiredError extends Error {
  readonly status = 401;
  constructor(message = "Session expired. Sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export function isSessionExpiredError(e: unknown): boolean {
  return e instanceof SessionExpiredError;
}

export type RefreshSessionResult =
  | { ok: true; token: string; user: JsonAuth["user"] }
  | { ok: false; reason: "invalid" | "network" };

/** POST /api/auth/refresh — re-issue JWT (accepts recently expired tokens). */
export async function refreshAuthSession(token: string): Promise<RefreshSessionResult> {
  const url = apiFullUrl("/api/auth/refresh");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: 20_000,
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  const raw = await res.text();
  let json: JsonAuth = {};
  try {
    json = raw ? (JSON.parse(raw) as JsonAuth) : {};
  } catch {
    return { ok: false, reason: "network" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid" };
  }
  if (!res.ok || !json.token) {
    return { ok: false, reason: "network" };
  }

  return {
    ok: true,
    token: String(json.token).trim(),
    user: json.user ?? null,
  };
}
