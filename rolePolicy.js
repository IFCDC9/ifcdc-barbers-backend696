/**
 * External requests may only claim `user` (Customer), `barber`, or `shop_owner`.
 * `super_admin` / platform owner is never accepted from the wire — only created via server seed.
 */
import { normalizeEmail } from "./authStore.js";

/** Fixed platform owner inbox — the only email that may hold `super_admin`. */
export const CANONICAL_SUPER_ADMIN_EMAIL = "service@ifcdc.org";

/** Roles that clients may request on register/signup (never `super_admin`). */
export const ALLOWED_EXTERNAL_ROLES = ["user", "barber", "shop_owner"];

/** Elevated roles that must never be assigned via public signup (wire tampering). */
const FORBIDDEN_PUBLIC_SIGNUP_ROLES = new Set([
  "admin",
  "super_admin",
  "superadmin",
  "super-admin",
  "platform_admin",
  "platformadmin",
  "owner",
  "platform_owner",
  "root",
  "master",
]);

/**
 * True when a raw role string is an elevated/platform role — reject with 403 on public signup.
 */
export function isForbiddenPublicSignupRole(roleRaw) {
  let r = String(roleRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  if (r === "superadmin") r = "super_admin";
  if (r === "shopowner" || r === "shop-owner") r = "shop_owner";
  if (FORBIDDEN_PUBLIC_SIGNUP_ROLES.has(r)) return true;
  if (r.includes("super") && r.includes("admin")) return true;
  if (r === "administrator") return true;
  return false;
}

/** Canonical owner email (normalized). */
export function getSuperAdminEmail() {
  return normalizeEmail(CANONICAL_SUPER_ADMIN_EMAIL);
}

export function isSuperAdminEmail(email) {
  return normalizeEmail(email) === getSuperAdminEmail();
}

/**
 * Registration/signup role from the request: allow-listed keys only (`accountType`, `account_type`, or legacy `role`).
 * Values are clamped to Customer (`user`), Barber (`barber`), or Shop owner (`shop_owner`).
 */
export function resolveRoleFromTrustedSource(req) {
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  const intent = body.accountType ?? body.account_type ?? body.role ?? "user";
  return resolveRoleFromExternalRequest(intent);
}

/**
 * Clamp intent string to Customer (`user`), Barber, or Shop owner only.
 * Prefer `resolveRoleFromTrustedSource(req)` for HTTP handlers.
 */
export function resolveRoleFromExternalRequest(bodyRoleRaw) {
  let r = String(bodyRoleRaw ?? "user").trim().toLowerCase().replace(/\s+/g, "_");
  if (r === "customer") r = "user";
  if (r === "shopowner" || r === "shop-owner") r = "shop_owner";
  if (isForbiddenPublicSignupRole(r)) {
    return null;
  }
  if (!ALLOWED_EXTERNAL_ROLES.includes(r)) {
    r = "user";
  }
  return r;
}

/** @deprecated Prefer `resolveRoleFromTrustedSource(req)` for HTTP handlers */
export function resolveSignupRole(_email, bodyRoleRaw) {
  return resolveRoleFromExternalRequest(bodyRoleRaw);
}

/** Clamp a raw role string to allowed external roles only. */
export function sanitizeUntrustedRole(roleRaw) {
  return resolveRoleFromExternalRequest(roleRaw);
}
