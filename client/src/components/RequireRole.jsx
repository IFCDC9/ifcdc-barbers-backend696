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
  if (!allowed.includes(role)) {
    return <Navigate to="/" replace />;
  }
  return children;
}
