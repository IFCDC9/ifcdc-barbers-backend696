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

/** POST /api/auth/refresh — re-issue JWT (accepts recently expired tokens). */
export async function refreshAuthSession(token: string): Promise<{ token: string; user: JsonAuth["user"] } | null> {
  const url = apiFullUrl("/api/auth/refresh");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: 15_000,
    });
  } catch {
    return null;
  }
  const raw = await res.text();
  let json: JsonAuth = {};
  try {
    json = raw ? (JSON.parse(raw) as JsonAuth) : {};
  } catch {
    return null;
  }
  if (!res.ok || !json.token) return null;
  return { token: String(json.token).trim(), user: json.user ?? null };
}
