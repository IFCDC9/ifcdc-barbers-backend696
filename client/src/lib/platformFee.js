/** Default IFCDC platform fee per paid booking (USD). Override with VITE_PLATFORM_FEE at build time. */
export const DEFAULT_PLATFORM_FEE_USD = 0.99;

function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function viteEnv() {
  return typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
}

export function clientDefaultPlatformFeeUsd() {
  const n = Number(viteEnv().VITE_PLATFORM_FEE);
  if (Number.isFinite(n) && n > 0) return roundMoney2(n);
  return DEFAULT_PLATFORM_FEE_USD;
}

/**
 * Customer checkout platform fee — always applied unless API sends a positive override.
 * @param {object | null} publicPricing - from GET /api/barber/public/:id/pricing
 */
export function resolveClientPlatformFeeUsd(publicPricing = null) {
  const fromApi = Number(publicPricing?.platform_fee_usd);
  if (Number.isFinite(fromApi) && fromApi > 0) return roundMoney2(fromApi);
  return clientDefaultPlatformFeeUsd();
}
