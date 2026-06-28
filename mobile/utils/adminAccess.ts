import { decodeJwtPayload } from "../auth/jwtSession";
import type { AppUser } from "../services/authContext";

/** Platform super-admin — never shown to regular customers. */
export function isSuperAdminUser(user: AppUser | null | undefined, token?: string | null): boolean {
  if (user?.isSuperAdmin === true || user?.isOwner === true) return true;
  if (String(user?.role || "").toLowerCase() === "super_admin") return true;

  if (token) {
    const payload = decodeJwtPayload(token);
    if (!payload) return false;
    if (payload.isSuperAdmin === true || payload.isOwner === true) return true;
    if (String(payload.role || "").toLowerCase() === "super_admin") return true;
  }

  return false;
}

export type { AppUser };
