/** IFCDC mandatory platform fee (USD). Full payment only — no deposits. */
export const IFCDC_PLATFORM_FEE_USD = 0.99;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Checkout total: full service price + platform fee.
 * @param {{ haircutPrice?: number, platformFee?: number }} [input]
 */
export function calculateFinalBookingTotal({
  haircutPrice = 25,
  platformFee = IFCDC_PLATFORM_FEE_USD,
  discountAmount = 0,
  tipAmount = 0,
} = {}) {
  const hp = round2(Math.max(0, Number(haircutPrice)));
  const pf = round2(Number(platformFee));
  const discount = round2(Math.max(0, Number(discountAmount)));
  const tip = round2(Math.max(0, Number(tipAmount)));

  if (!Number.isFinite(hp) || hp <= 0 || hp > 500) {
    throw new Error("invalid_haircut_price");
  }
  if (pf !== IFCDC_PLATFORM_FEE_USD) {
    throw new Error("platform_fee_invalid");
  }
  if (!Number.isFinite(discount) || discount > hp) {
    throw new Error("discount_invalid");
  }
  if (!Number.isFinite(tip) || tip > 500) {
    throw new Error("tip_invalid");
  }

  const total = round2(hp - discount + pf + tip);

  return {
    haircutPrice: hp,
    depositAmount: 0,
    platformFee: pf,
    discountAmount: discount,
    tipAmount: tip,
    total,
    remainingBalance: 0,
  };
}
