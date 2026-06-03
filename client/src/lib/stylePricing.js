/** Client-side mirror of server `styleBookingPricing.js` — full payment only. */
import { resolveClientPlatformFeeUsd } from "./platformFee.js";

export function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Deposits removed — always false. */
export function depositEnabled() {
  return false;
}

/** @deprecated */
export function depositForStylePrice(_stylePrice) {
  return 0;
}

const TIP_PRESETS = new Set([5, 10, 15]);

export function parseTipAmount(serviceSubtotal, { tipPercent, tipAmount, customTip } = {}) {
  const base = roundMoney2(serviceSubtotal);
  const custom = Number(tipAmount ?? customTip);
  if (Number.isFinite(custom) && custom > 0) {
    const cap = roundMoney2(Math.max(base * 2, 500));
    return roundMoney2(Math.min(custom, cap));
  }
  const pct = Number(tipPercent);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!TIP_PRESETS.has(pct)) return 0;
  return roundMoney2((base * pct) / 100);
}

/**
 * @param {object | null} publicPricing - from GET /api/barber/public/:id/pricing (optional)
 */
export function computeChargeBreakdown(stylePrice, _paymentType, tipOpts = {}, publicPricing = null) {
  const totalPrice = roundMoney2(stylePrice);
  const serviceCharge = totalPrice;
  const platformFee = resolveClientPlatformFeeUsd(publicPricing);
  const subtotalBeforeTip = roundMoney2(serviceCharge + platformFee);
  const tipAmount = parseTipAmount(subtotalBeforeTip, tipOpts);
  const paypalTotal = roundMoney2(subtotalBeforeTip + tipAmount);
  const totalAmount = roundMoney2(totalPrice + platformFee);
  return {
    totalPrice,
    depositAmount: 0,
    serviceCharge,
    platformFee,
    subtotalBeforeTip,
    totalAmount,
    tipAmount,
    paypalTotal,
    paymentType: "full",
  };
}

export function normalizeCheckoutBreakdown(breakdown, publicPricing = null) {
  if (!breakdown || typeof breakdown !== "object") return breakdown;
  const expectedFee = resolveClientPlatformFeeUsd(publicPricing);
  const currentFee = Number(breakdown.platformFee);
  const serviceCharge = roundMoney2(breakdown.totalPrice ?? breakdown.serviceCharge ?? 0);
  const platformFee = Number.isFinite(currentFee) && currentFee > 0 ? roundMoney2(currentFee) : expectedFee;
  const subtotalBeforeTip = roundMoney2(serviceCharge + platformFee);
  const tipAmount = roundMoney2(breakdown.tipAmount || 0);
  const totalPrice = roundMoney2(breakdown.totalPrice ?? serviceCharge);
  return {
    ...breakdown,
    depositAmount: 0,
    serviceCharge,
    platformFee,
    subtotalBeforeTip,
    totalAmount: roundMoney2(totalPrice + platformFee),
    tipAmount,
    paypalTotal: roundMoney2(subtotalBeforeTip + tipAmount),
    paymentType: "full",
  };
}
