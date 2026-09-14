/**
 * GET /api/auth/me — source of truth for managementRole / shop scope.
 * JWT is identity only; never trust a managementRole cached at login.
 * localStorage is a display cache of the last /me payload, replaced on every hydrate.
 */
import { getApiOrigin } from "../services/api.js";
import { clearAuthSession, persistAuthSession } from "./authHeaders.js";

export async function fetchAuthMe(token, origin = getApiOrigin()) {
  const res = await fetch(`${String(origin || "").replace(/\/$/, "")}/api/auth/me`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export function managementVersionOf(user) {
  if (!user || typeof user !== "object") return "";
  return String(user.managementVersion || user.managementUpdatedAt || "");
}

/**
 * Refresh stored session from /me. Returns the current public user, or null if signed out.
 * Successful /me always overwrites cached management fields (role, shops, version).
 */
export async function hydrateAuthSessionFromMe({ token, fallbackUser = null } = {}) {
  const bearer = String(token || "").trim();
  if (!bearer) return fallbackUser;
  try {
    const { res, data } = await fetchAuthMe(bearer);
    if (res.status === 401 || res.status === 403) {
      clearAuthSession();
      return null;
    }
    if (!res.ok || !data?.user) {
      if (fallbackUser) persistAuthSession({ token: bearer, user: fallbackUser });
      return fallbackUser;
    }
    persistAuthSession({
      token: data.token || bearer,
      user: data.user,
    });
    return data.user;
  } catch {
    if (fallbackUser) persistAuthSession({ token: bearer, user: fallbackUser });
    return fallbackUser;
  }
}
