/**
 * Optional platform fallback when no shop phone exists in the database.
 * Primary source: GET /api/config → `businesses.phone` (managed in Barber/Shop Settings).
 * Set `VITE_BUSINESS_PHONE` at build time only if you need a temporary IFCDC-wide fallback.
 */
const platformFallback = String(import.meta.env.VITE_BUSINESS_PHONE ?? "").trim();

export const SYSTEM_CONFIG = {
  BUSINESS_PHONE: platformFallback,
};
