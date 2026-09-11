/**
 * Management Team RBAC helpers — load assignments, enforce shop/location + permissions.
 * Super Admin bypasses all manager scopes. Managers never gain Super Admin powers.
 */
import { dbQuery } from "./db.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import {
  MANAGEMENT_PERMISSIONS,
  MANAGEMENT_ROLES,
  expandEffectivePermissions,
  hasEffectivePermission,
  isValidManagementRole,
  normalizePermissionKey,
} from "./managementPermissions.js";

export async function loadActiveManagementContext(userId) {
  if (!userId) return null;
  const assignmentRes = await dbQuery(
    `SELECT *
     FROM management_assignments
     WHERE user_id = $1::uuid
       AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(userId)],
  );
  const assignment = assignmentRes.rows?.[0];
  if (!assignment) return null;

  const [shops, locations, perms] = await Promise.all([
    dbQuery(
      `SELECT business_id FROM manager_shop_access WHERE assignment_id = $1::uuid`,
      [assignment.id],
    ),
    dbQuery(
      `SELECT location_id FROM manager_location_access WHERE assignment_id = $1::uuid`,
      [assignment.id],
    ),
    dbQuery(
      `SELECT permission_key, enabled FROM manager_permissions WHERE assignment_id = $1::uuid`,
      [assignment.id],
    ),
  ]);

  const permissionMap = {};
  for (const row of perms.rows || []) {
    permissionMap[String(row.permission_key)] = row.enabled === true;
  }
  if (assignment.full_access === true) {
    permissionMap[MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS] = true;
  }

  return {
    assignmentId: String(assignment.id),
    userId: String(assignment.user_id),
    role: String(assignment.role),
    status: String(assignment.status),
    fullAccess: assignment.full_access === true,
    shopIds: (shops.rows || []).map((r) => Number(r.business_id)).filter(Number.isFinite),
    locationIds: (locations.rows || []).map((r) => String(r.location_id)),
    permissions: expandEffectivePermissions(permissionMap),
  };
}

export function isProtectedSuperAdminUser(userRow) {
  if (!userRow) return false;
  const role = String(userRow.role || "").trim().toLowerCase();
  if (role === "super_admin") return true;
  return isSuperAdminEmail(userRow.email);
}

/**
 * Resolve business scope for an authenticated actor.
 * Super Admin → all. Active manager → assigned shops only. Else fall through to caller defaults.
 */
export async function resolveManagementBusinessScope(user) {
  if (isJwtGlobalSuperScope(user)) {
    return { all: true, businessIds: null, isSuperAdmin: true, management: null };
  }
  const ctx = await loadActiveManagementContext(user?.id);
  if (!ctx) {
    return { all: false, businessIds: [], isSuperAdmin: false, management: null };
  }
  return {
    all: false,
    businessIds: ctx.shopIds.slice(),
    isSuperAdmin: false,
    management: ctx,
  };
}

export function managerCanAccessShop(managementCtx, businessId) {
  if (!managementCtx) return false;
  const bid = Number(businessId);
  if (!Number.isFinite(bid)) return false;
  return managementCtx.shopIds.includes(bid);
}

export async function managerCanAccessLocation(managementCtx, locationId) {
  if (!managementCtx || !locationId) return false;
  if (managementCtx.locationIds.includes(String(locationId))) return true;
  // Location managers must be explicitly assigned; shop/platform managers with shop access
  // may access locations under their shops when no location list is set, except location_manager.
  if (managementCtx.role === MANAGEMENT_ROLES.LOCATION_MANAGER) return false;
  if (!managementCtx.shopIds.length) return false;
  const r = await dbQuery(
    `SELECT business_id FROM shop_locations WHERE id = $1::uuid LIMIT 1`,
    [String(locationId)],
  );
  const bid = r.rows?.[0]?.business_id;
  return managerCanAccessShop(managementCtx, bid);
}

export function managerHasPermission(managementCtx, permissionKey) {
  if (!managementCtx) return false;
  return hasEffectivePermission(managementCtx.permissions, permissionKey);
}

/**
 * Merge management scope into existing admin shop scope pattern.
 * Returns null + writes response when denied.
 */
export async function augmentShopManagementScope(payload, res) {
  if (isJwtGlobalSuperScope(payload)) {
    return { all: true, actorId: String(payload.id || ""), isSuperAdmin: true, management: null };
  }

  const role = String(payload?.role || "").trim().toLowerCase();
  const ctx = await loadActiveManagementContext(payload?.id);

  if (ctx) {
    if (!ctx.shopIds.length && ctx.role !== MANAGEMENT_ROLES.LOCATION_MANAGER) {
      res.status(403).json({ ok: false, message: "No shops assigned to this manager." });
      return null;
    }
    // Location-only managers: derive shops from assigned locations
    let shopIds = ctx.shopIds.slice();
    if (ctx.role === MANAGEMENT_ROLES.LOCATION_MANAGER && ctx.locationIds.length) {
      const locShops = await dbQuery(
        `SELECT DISTINCT business_id FROM shop_locations WHERE id = ANY($1::uuid[])`,
        [ctx.locationIds],
      );
      const derived = (locShops.rows || []).map((r) => Number(r.business_id)).filter(Number.isFinite);
      shopIds = Array.from(new Set([...shopIds, ...derived]));
      ctx.shopIds = shopIds;
    }
    return {
      all: false,
      businessIds: shopIds,
      businessId: shopIds.length === 1 ? shopIds[0] : null,
      actorId: String(payload.id || ""),
      isSuperAdmin: false,
      management: ctx,
    };
  }

  // Legacy platform admin (non–super-admin) keeps global access only if role is admin
  // and there is no management assignment — Super Admin JWT already handled above.
  if (role === "admin") {
    return { all: true, actorId: String(payload.id || ""), isSuperAdmin: false, management: null };
  }

  if (role === "shop_owner") {
    const r = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [
      String(payload.id),
    ]);
    const bid = r.rows?.[0]?.business_id;
    const businessId = bid != null && bid !== "" ? Number(bid) : NaN;
    if (!Number.isFinite(businessId)) {
      res.status(403).json({ ok: false, message: "Shop owner account is not linked to a business." });
      return null;
    }
    return {
      all: false,
      businessId,
      businessIds: [businessId],
      actorId: String(payload.id || ""),
      isSuperAdmin: false,
      management: null,
    };
  }

  res.status(403).json({ ok: false, message: "Access denied" });
  return null;
}

export function assertShopInManagementScope(scope, businessId) {
  if (!scope) return false;
  if (scope.all) return true;
  const bid = Number(businessId);
  if (!Number.isFinite(bid)) return false;
  if (Array.isArray(scope.businessIds) && scope.businessIds.length) {
    return scope.businessIds.map(Number).includes(bid);
  }
  return Number(scope.businessId) === bid;
}

export function requireManagerPermission(scope, permissionKey, res) {
  if (!scope) return false;
  if (scope.isSuperAdmin || scope.all) return true;
  if (!scope.management) {
    // shop_owner / legacy admin without assignment: allow operational shop actions
    return true;
  }
  if (!managerHasPermission(scope.management, permissionKey)) {
    res.status(403).json({
      ok: false,
      error: "permission_denied",
      message: `Missing permission: ${normalizePermissionKey(permissionKey)}`,
    });
    return false;
  }
  return true;
}

export function requireSuperAdminActor(payload, res) {
  if (isJwtGlobalSuperScope(payload)) return true;
  res.status(403).json({
    ok: false,
    error: "super_admin_required",
    message: "Only Super Admin can manage the Management Team.",
  });
  return false;
}

export function validateAssignmentPayload(body) {
  const role = String(body?.role || "").trim().toLowerCase();
  if (!isValidManagementRole(role)) {
    return { ok: false, message: "Invalid management role." };
  }
  const shopIds = Array.isArray(body?.shopIds)
    ? body.shopIds.map((n) => Number(n)).filter(Number.isFinite)
    : [];
  const locationIds = Array.isArray(body?.locationIds)
    ? body.locationIds.map((id) => String(id).trim()).filter(Boolean)
    : [];

  if (role === MANAGEMENT_ROLES.LOCATION_MANAGER && !locationIds.length) {
    return { ok: false, message: "Location Manager requires at least one location." };
  }
  if (
    (role === MANAGEMENT_ROLES.PLATFORM_MANAGER || role === MANAGEMENT_ROLES.SHOP_MANAGER) &&
    !shopIds.length
  ) {
    return { ok: false, message: "Assign at least one shop." };
  }

  const permissions = body?.permissions && typeof body.permissions === "object" ? body.permissions : {};
  return { ok: true, role, shopIds, locationIds, permissions, fullAccess: body?.fullAccess === true };
}
