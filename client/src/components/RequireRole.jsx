import { Navigate, useLocation } from "react-router-dom";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";

function normalizeRole(r) {
  return String(r || "").trim().toLowerCase();
}

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

  if (!role || !token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (u?.isSuperAdmin === true || u?.isOwner === true) {
    return children;
  }
  if (allowed.includes(role)) {
    return children;
  }
  // Managers may use shop-scoped admin surfaces (routes that also allow shop_owner).
  // They must NOT access Super Admin-only pages (admin/super_admin only).
  if (u?.isManager === true && allowed.includes("shop_owner")) {
    return children;
  }
  return <Navigate to="/" replace />;
}
