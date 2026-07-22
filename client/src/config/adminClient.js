/** localStorage key sent as HTTP header `x-admin-key` — must match server `ADMIN_SECRET`. */
export const ADMIN_KEY_STORAGE = "ifcdc_admin_key"

/**
 * Admin API key from build-time `VITE_ADMIN_API_KEY` only (must match server `ADMIN_SECRET`).
 * No hardcoded fallback — empty means admin calls must use a key entered/stored at runtime.
 * Never use Supabase service_role here.
 */
export const UNIFIED_ADMIN_KEY = ""

export function getResolvedAdminApiKey() {
  const fromEnv = String(import.meta.env.VITE_ADMIN_API_KEY || "").trim()
  if (fromEnv) return fromEnv
  if (typeof localStorage !== "undefined") {
    const stored = String(localStorage.getItem(ADMIN_KEY_STORAGE) || "").trim()
    if (stored) return stored
  }
  return UNIFIED_ADMIN_KEY
}
