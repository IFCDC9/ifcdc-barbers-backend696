import { decodeJwtPayload } from "../auth/jwtSession";
import type { AppUser } from "../services/profileApi";
import { isSuperAdminUser } from "./adminAccess";
import { isActiveManager } from "./staffDashboardAccess";

/** Shop management — super admin, shop owner, admin, or ACTIVE Management Team manager. */
export function canManageShops(user: AppUser | null | undefined, token?: string | null): boolean {
  if (isSuperAdminUser(user, token)) return true;
  if (isActiveManager(user as any)) return true;
  const role = String(
    user?.role || (token ? decodeJwtPayload(token)?.role : "") || "",
  ).toLowerCase();
  return role === "shop_owner" || role === "admin";
}
