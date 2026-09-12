import { Navigate, useLocation } from "react-router-dom";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";
import { isActiveManager, isPlatformAdmin, normalizeRole } from "../lib/staffDashboardAccess.js";

/** @deprecated Use getStoredUser from ../lib/authHeaders.js */
export function getStoredUserLegacy() {
  return getStoredUser();
}

export default function RequireRole({ roles, children }) {
  const location = useLocation();
  const u = getStoredUser();
  const token = getStoredToken();
  const role = normalizeRole(u?.role);
  const allowed = Array.isArray(roles) ? roles.map(normalizeRole) : [normalizeRole(roles)];

  if (!token || (!role && !isActiveManager(u))) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (isPlatformAdmin(u)) {
    return children;
  }
  if (role && allowed.includes(role)) {
    return children;
  }
  // ACTIVE managers may use shop-scoped admin surfaces (routes that also allow shop_owner).
  // They must NOT access Super Admin-only pages (admin/super_admin only).
  if (isActiveManager(u) && allowed.includes("shop_owner")) {
    return children;
  }
  return <Navigate to="/" replace />;
}
