import { SYSTEM_CONFIG } from "../config/systemConfig.js";

/**
 * Customer-facing display phone: prefer API/shop value, then optional build-time env fallback.
 * Do not hard-code numbers here — shops set `businesses.phone` via Settings (`PUT /api/shop/detail`).
 */
export function resolveDisplayBusinessPhone(apiPhone) {
  const fromApi = String(apiPhone ?? "").trim();
  if (fromApi) return fromApi;
  return String(SYSTEM_CONFIG.BUSINESS_PHONE ?? "").trim();
}
