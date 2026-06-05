import { requireAdmin } from "./requireAdmin.js"

/**
 * Allow admin uploads via x-admin-key OR authenticated staff (JWT Bearer).
 * Used for POST /api/upload so Admin panel and Barber Settings share one route.
 */
export function requireAdminOrAuth(requireAuth) {
  return (req, res, next) => {
    const expectedKey = String(process.env.ADMIN_SECRET || "").trim()
    const adminKey = String(req.get("x-admin-key") || "").trim()
    if (expectedKey && adminKey && adminKey === expectedKey) {
      return next()
    }
    return requireAuth(req, res, next)
  }
}

/** Admin key only — same as requireAdmin but exported for explicit routes. */
export { requireAdmin }
