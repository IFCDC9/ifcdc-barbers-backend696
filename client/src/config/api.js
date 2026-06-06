/**
 * Default backend origin when `VITE_API_URL` / `VITE_API_BASE` are unset at build time.
 * - **Production, same host:** leave unset → empty string → requests use relative `/api/...`
 *   (Express serves `client/dist` + API on one origin; no CORS issues).
 * - **Production, split static + API:** set `VITE_API_BASE=https://your-api.onrender.com` at build time.
 * - **Dev (LAN):** set `VITE_API_URL=http://<LAN-IP>:5050` in `client/.env`.
 */
const env = typeof import.meta !== "undefined" ? import.meta.env : {}
const fromEnv = String(env.VITE_API_BASE || env.VITE_API_URL || "").trim()

/** Split-host production (ifcdcbarbersapp.com static → backend696 API). */
export const PRODUCTION_API_ORIGIN = "https://ifcdc-barbers-backend696.onrender.com"

export const API_BASE_URL =
  fromEnv ||
  (env.PROD ? "" : String(env.VITE_API_URL || "").trim())
