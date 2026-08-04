import { decodeJwtPayload } from "../auth/jwtSession";
import type { AppUser } from "../auth/authSessionApi";
import { isSuperAdminUser } from "./adminAccess";

export type StaffRole = "super_admin" | "admin" | "shop_owner" | "barber";

export function resolveStaffRole(user: AppUser | null | undefined, token?: string | null): StaffRole | null {
  const role = String(user?.role || "").toLowerCase();
  if (role === "super_admin" || isSuperAdminUser(user, token)) return "super_admin";
  if (role === "admin") return "admin";
  if (role === "shop_owner") return "shop_owner";
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

/** Show Manage/Admin tab for platform admins and shop owners. */
export function hasStaffDashboardAccess(user: AppUser | null | undefined, token?: string | null): boolean {
  const role = resolveStaffRole(user, token);
  return role === "super_admin" || role === "admin" || role === "shop_owner";
}

export function canAccessAdminMenuKey(
  key: string,
  user: AppUser | null | undefined,
  token?: string | null,
): boolean {
  const role = resolveStaffRole(user, token);
  if (!role) return false;
  if (key === "manual_booking") {
    return role === "super_admin" || isSuperAdminUser(user, token);
  }
  if (key === "sms_delivery") {
    return role === "super_admin" || isSuperAdminUser(user, token);
  }
  if (role === "super_admin") return true;
  if (role === "admin") {
    return !["users", "manual_booking"].includes(key);
  }
  if (role === "shop_owner") {
    return ["bookings", "services", "barbers", "shop", "schedule"].includes(key);
  }
  return false;
}
