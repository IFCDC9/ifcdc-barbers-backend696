/**
 * Web staff / manager access helpers — mirrors mobile/utils/staffDashboardAccess.ts.
 * Base app_users.role stays customer/user; elevated access comes from ACTIVE management assignment.
 */

export function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

/** ACTIVE Management Team assignment (Shop / Platform / Location Manager). */
export function isActiveManager(user) {
  if (!user || user.isManager !== true) return false;
  const status = String(user.managementStatus || "active").toLowerCase();
  return status === "active";
}

export function isPlatformAdmin(user) {
  if (!user) return false;
  if (user.isSuperAdmin === true || user.isOwner === true) return true;
  const role = normalizeRole(user.role);
  return role === "super_admin" || role === "admin";
}

/** Shop owners, ACTIVE managers, barbers, and platform admins. */
export function hasStaffDashboardAccess(user) {
  if (!user) return false;
  if (isPlatformAdmin(user)) return true;
  if (isActiveManager(user)) return true;
  const role = normalizeRole(user.role);
  return role === "shop_owner" || role === "barber";
}

/** Shop-scoped management surfaces (also allow shop_owner routes). */
export function canAccessShopManagement(user) {
  if (!user) return false;
  if (isPlatformAdmin(user)) return true;
  if (isActiveManager(user)) return true;
  return normalizeRole(user.role) === "shop_owner";
}

export function managementRoleLabel(user) {
  if (!isActiveManager(user)) return null;
  const r = String(user.managementRole || "").toLowerCase();
  if (r === "platform_manager") return "Platform Manager";
  if (r === "location_manager") return "Location Manager";
  if (r === "shop_manager") return "Shop Manager";
  return "Manager";
}

/**
 * Post-login destination for the website (management-aware).
 * Managers land on shop management — never Super Admin console.
 */
export function postLoginPath(user) {
  if (!user) return "/booking";
  if (isPlatformAdmin(user)) return "/admin";
  if (isActiveManager(user) || normalizeRole(user.role) === "shop_owner") {
    return "/admin/shops";
  }
  if (normalizeRole(user.role) === "barber") return "/barber-settings";
  return "/booking";
}
