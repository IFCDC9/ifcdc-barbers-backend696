import { decodeJwtPayload } from "../auth/jwtSession";
import type { AppUser } from "../auth/authSessionApi";
import { isSuperAdminUser } from "./adminAccess";

export type StaffRole = "super_admin" | "admin" | "shop_owner" | "barber" | "manager";

/** ACTIVE Management Team assignment (Shop/Platform/Location Manager). */
export function isActiveManager(user: AppUser | null | undefined): boolean {
  if (!user) return false;
  if (user.isManager !== true) return false;
  const status = String(user.managementStatus || "active").toLowerCase();
  return status === "active";
}

/** Display label for ACTIVE Management Team roles (from /me, never JWT). */
export function managementRoleLabel(user: AppUser | null | undefined): string | null {
  if (!isActiveManager(user)) return null;
  const r = String(user?.managementRole || "").toLowerCase();
  if (r === "platform_manager") return "Platform Manager";
  if (r === "location_manager") return "Location Manager";
  if (r === "shop_manager") return "Shop Manager";
  return "Manager";
}

export function resolveStaffRole(user: AppUser | null | undefined, token?: string | null): StaffRole | null {
  if (isSuperAdminUser(user, token)) return "super_admin";
  const role = String(user?.role || "").toLowerCase();
  if (role === "super_admin") return "super_admin";
  if (role === "admin") return "admin";
  if (role === "shop_owner") return "shop_owner";
  if (isActiveManager(user)) return "manager";
  if (role === "barber") return "barber";
  if (token) {
    const payload = decodeJwtPayload(token);
    const jwtRole = String(payload?.role || "").toLowerCase();
    if (jwtRole === "super_admin" || payload?.isSuperAdmin) return "super_admin";
    if (jwtRole === "admin") return "admin";
    if (jwtRole === "shop_owner") return "shop_owner";
    if (jwtRole === "barber") return "barber";
  }
  return null;
}

/** Show Manage/Admin tab for platform admins, shop owners, and ACTIVE managers. */
export function hasStaffDashboardAccess(user: AppUser | null | undefined, token?: string | null): boolean {
  if (isActiveManager(user)) return true;
  const role = resolveStaffRole(user, token);
  return role === "super_admin" || role === "admin" || role === "shop_owner" || role === "manager";
}

export function canAccessAdminMenuKey(
  key: string,
  user: AppUser | null | undefined,
  token?: string | null,
): boolean {
  if (isSuperAdminUser(user, token)) {
    return true;
  }
  const role = resolveStaffRole(user, token);
  if (!role) return false;

  // Super Admin–only surfaces
  if (key === "manual_booking" || key === "sms_delivery" || key === "users") {
    return false;
  }

  if (role === "admin") {
    return !["users", "manual_booking", "sms_delivery"].includes(key);
  }

  // Shop owners + Management Team managers: scoped operational tools only
  if (role === "shop_owner" || role === "manager") {
    return ["bookings", "services", "barbers", "shop", "schedule", "notifications", "analytics", "payout"].includes(
      key,
    );
  }

  return false;
}
