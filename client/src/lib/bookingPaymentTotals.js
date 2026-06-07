/** IFCDC mandatory platform fee (USD). Full payment only — no deposits. */
export const IFCDC_PLATFORM_FEE_USD = 0.99;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Checkout total: full service price + platform fee (matches TestFlight app).
 */
export function calculateFinalBookingTotal({
  haircutPrice = 25,
  platformFee = IFCDC_PLATFORM_FEE_USD,
} = {}) {
  const hp = round2(Math.max(0, Number(haircutPrice)));
  const pf = round2(Number(platformFee));

  if (!Number.isFinite(hp) || hp <= 0 || hp > 500) {
    throw new Error("invalid_haircut_price");
  }
  if (pf !== IFCDC_PLATFORM_FEE_USD) {
    throw new Error("platform_fee_invalid");
  }

  return {
    haircutPrice: hp,
    depositAmount: 0,
    platformFee: pf,
    total: round2(hp + pf),
    remainingBalance: 0,
  };
}
