/**
 * Public signup roles: Customer, Barber, Shop Admin (`shop_owner` in DB — tenant-scoped).
 * Platform `admin` / `super_admin` are never created from public registration.
 * Super Admin is reserved for service@ifcdc.org via server seed only.
 */
import { normalizeEmail } from "./authStore.js";

/** Fixed platform owner inbox — the only email that may hold `super_admin`. */
export const CANONICAL_SUPER_ADMIN_EMAIL = "service@ifcdc.org";

/** Roles stored on app_users when someone self-registers (never platform admin/super_admin). */
export const ALLOWED_PUBLIC_SIGNUP_ROLES = ["user", "barber", "shop_owner"];

/** @deprecated use ALLOWED_PUBLIC_SIGNUP_ROLES */
export const ALLOWED_EXTERNAL_ROLES = ALLOWED_PUBLIC_SIGNUP_ROLES;

/** Wire aliases → shop-scoped shop_owner (Shop Admin). */
const PUBLIC_SIGNUP_ROLE_ALIASES = {
  admin: "shop_owner",
  shop_admin: "shop_owner",
  shopadmin: "shop_owner",
  shop_owner: "shop_owner",
  owner: "shop_owner",
  customer: "user",
  client: "user",
  user: "user",
  barber: "barber",
};

/**
 * True when a raw role string requests Super Admin / platform operator — reject on public signup.
 */
export function isForbiddenPublicSignupRole(roleRaw) {
  let r = String(roleRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
  if (r === "superadmin") r = "super_admin";
  if (r === "shopowner" || r === "shop-owner") r = "shop_owner";

  if (r === "super_admin") return true;
  if (r.includes("super") && r.includes("admin")) return true;
  if (r === "platform_admin" || r === "platformadmin") return true;
  return false;
}

/** Canonical owner email (normalized). */
export function getSuperAdminEmail() {
  return normalizeEmail(CANONICAL_SUPER_ADMIN_EMAIL);
}

export function isSuperAdminEmail(email) {
  return normalizeEmail(email) === getSuperAdminEmail();
}

function normalizePublicSignupRoleIntent(bodyRoleRaw) {
  let r = String(bodyRoleRaw ?? "user").trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (PUBLIC_SIGNUP_ROLE_ALIASES[r]) return PUBLIC_SIGNUP_ROLE_ALIASES[r];
  if (r === "shopowner" || r === "shop-owner") return "shop_owner";
  return r;
}

/**
 * Registration/signup role from the request: allow-listed keys only (`accountType`, `account_type`, or legacy `role`).
 */
export function resolveRoleFromTrustedSource(req) {
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  const intent = body.accountType ?? body.account_type ?? body.role ?? "user";
  return resolveRoleFromExternalRequest(intent);
}

/**
 * Public signup role — Customer, Barber, or Shop Admin (`shop_owner`).
 * Wire `admin` / `shop_admin` map to shop_owner (tenant-scoped), never platform admin.
 */
export function resolveRoleFromExternalRequest(bodyRoleRaw) {
  const r = normalizePublicSignupRoleIntent(bodyRoleRaw);
  if (isForbiddenPublicSignupRole(r)) {
    return null;
  }
  if (!ALLOWED_PUBLIC_SIGNUP_ROLES.includes(r)) {
    return "user";
  }
  return r;
}

/** @deprecated Prefer `resolveRoleFromTrustedSource(req)` for HTTP handlers */
export function resolveSignupRole(_email, bodyRoleRaw) {
  return resolveRoleFromExternalRequest(bodyRoleRaw);
}

/** Clamp a raw role string to allowed public signup roles only. */
export function sanitizeUntrustedRole(roleRaw) {
  return resolveRoleFromExternalRequest(roleRaw);
}
