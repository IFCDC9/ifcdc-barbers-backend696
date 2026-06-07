import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { isShopScopedStaffJwt } from "./securityPolicy.js";

/** Platform admin/super_admin only — not shop_owner. */
export function isPlatformBookingOpsJwt(payload) {
  if (!payload) return false;
  if (isJwtGlobalSuperScope(payload)) return true;
  const role = String(payload.role || "").trim().toLowerCase();
  return role === "admin";
}

/**
 * DELETE booking / PayPal refund — admin + super_admin (and x-admin-key), not shop_owner.
 */
export function createPlatformBookingOpsGuard({ resolveAuthPayload, adminSecretEnv = "ADMIN_SECRET" }) {
  return async function requirePlatformBookingOps(req, res, next) {
    const adminKey = String(req.get("x-admin-key") || "").trim();
    const expected = String(process.env[adminSecretEnv] || "").trim();
    if (expected && adminKey && adminKey === expected) {
      req.bookingsAdminScope = { all: true, via: "admin_key" };
      req.user = { role: "admin", id: null };
      return next();
    }

    const hdr = String(req.get("authorization") || "");
    const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
    if (!token) {
      return res.status(401).json({ ok: false, message: "Missing Bearer token" });
    }
    const payload = resolveAuthPayload(token);
    if (!payload) {
      return res.status(401).json({ ok: false, message: "Invalid or expired token" });
    }
    req.user = payload;

    if (!isPlatformBookingOpsJwt(payload)) {
      return res.status(403).json({
        ok: false,
        message: "Only platform administrators can delete bookings or issue refunds.",
      });
    }

    req.bookingsAdminScope = { all: true, via: isJwtGlobalSuperScope(payload) ? "platform_super" : "admin" };
    return next();
  };
}

/**
 * Admin bookings routes: platform operators see all rows; `shop_owner` sees only `bookings.business_id` for their shop.
 * Sets `req.user` (JWT payload), `req.bookingsAdminScope = { all: true } | { all: false, businessId: number }`.
 */
export function createBookingsAdminGuard({ resolveAuthPayload, dbQuery, adminSecretEnv = "ADMIN_SECRET" }) {
  return async function requireBookingsAdmin(req, res, next) {
    const adminKey = String(req.get("x-admin-key") || "").trim();
    const expected = String(process.env[adminSecretEnv] || "").trim();
    if (expected && adminKey && adminKey === expected) {
      req.bookingsAdminScope = { all: true, via: "admin_key" };
      req.user = { role: "admin", id: null, email: null };
      return next();
    }

    const hdr = String(req.get("authorization") || "");
    const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
    if (!token) {
      return res.status(401).json({ ok: false, message: "Missing Bearer token" });
    }
    const payload = resolveAuthPayload(token);
    if (!payload) {
      return res.status(401).json({ ok: false, message: "Invalid or expired token" });
    }
    req.user = payload;

    const role = String(payload?.role || "").trim().toLowerCase();
    if (isJwtGlobalSuperScope(payload) || role === "admin" || role === "super_admin") {
      req.bookingsAdminScope = { all: true, via: isJwtGlobalSuperScope(payload) ? "platform_super" : "admin" };
      return next();
    }

    if (isShopScopedStaffJwt(payload)) {
      const r = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(payload.id)]);
      const bid = r.rows?.[0]?.business_id;
      const n = bid != null && bid !== "" ? Number(bid) : NaN;
      if (!Number.isFinite(n)) {
        return res.status(403).json({
          ok: false,
          message: "Shop owner account is not linked to a business. Contact IFCDC support.",
        });
      }
      req.bookingsAdminScope = { all: false, businessId: n, via: "shop_owner" };
      return next();
    }

    return res.status(403).json({ ok: false, message: "Access denied" });
  };
}
