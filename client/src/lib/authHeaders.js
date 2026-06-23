/**
 * Web session auth — Bearer JWT for protected admin / barber API routes.
 */
import { ADMIN_KEY_STORAGE, getResolvedAdminApiKey } from "../config/adminClient.js";
import { LOGGED_IN_KEY, USER_PUBLIC_KEY } from "./authSession.js";

export const TOKEN_KEY = "token";
export const USER_KEY = "user";

export function getStoredToken() {
  try {
    return String(window.localStorage.getItem(TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function getStoredUser() {
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw?.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isJwtExpired(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return true;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return false;
    return exp * 1000 <= Date.now() + 5000;
  } catch {
    return true;
  }
}

/** Persist login/register session (token + user profile). */
export function persistAuthSession({ token, user } = {}) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, String(token));
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user));
      const role = String(user.role || "").toLowerCase();
      if (role === "admin" || role === "super_admin" || user.isSuperAdmin === true) {
        window.localStorage.setItem(LOGGED_IN_KEY, "1");
        window.localStorage.setItem(USER_PUBLIC_KEY, JSON.stringify(user));
      }
    }
  } catch {
    /* ignore */
  }
}

export function clearAuthSession() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.localStorage.removeItem(LOGGED_IN_KEY);
    window.localStorage.removeItem(USER_PUBLIC_KEY);
    window.localStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

/** Legacy x-admin-key header (dev / ops fallback when no JWT). */
export function getAdminKeyHeadersOnly() {
  try {
    const k = window.localStorage.getItem(ADMIN_KEY_STORAGE) || getResolvedAdminApiKey();
    if (k) return { "x-admin-key": k };
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Bearer JWT when present (always preferred after login).
 * Falls back to legacy x-admin-key only when no token is stored.
 */
export function getAdminAuthHeaders() {
  const token = getStoredToken();
  if (token) {
    return { Authorization: `Bearer ${token}`, Accept: "application/json" };
  }
  return { Accept: "application/json", ...getAdminKeyHeadersOnly() };
}

/** Alias for barber-scoped routes that require JWT only. */
export function getBearerAuthHeaders() {
  const token = getStoredToken();
  if (!token) return { Accept: "application/json" };
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export function hasAuthenticatedSession() {
  return Boolean(getStoredToken() && getStoredUser());
}
