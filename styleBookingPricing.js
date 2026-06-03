/**
 * Shared style-based booking charge + tip math (used by PayPal create-order and POST /api/book).
 * Full payment only — no deposits or partial payments.
 */
import { BARBER_PLATFORM_FEE_USD, platformFeeUsdForTier } from "./subscriptionTier.js";

export function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Minimum customer platform fee (USD) — never trust client-supplied fee fields. */
export function resolvePlatformFeeUsd(rawFee, tier) {
  const env = Number(process.env.PLATFORM_FEE);
  const configured =
    Number.isFinite(env) && env > 0 ? roundMoney2(env) : BARBER_PLATFORM_FEE_USD;
  const n = Number(rawFee);
  if (Number.isFinite(n) && n >= configured - 0.001) return roundMoney2(n);
  const tierFee = platformFeeUsdForTier(tier);
  if (Number.isFinite(tierFee) && tierFee >= configured - 0.001) return roundMoney2(tierFee);
  return configured;
}

/**
 * Recompute PayPal totals with enforced platform fee (server-only).
 */
export function enforcePlatformFeeOnBreakdown(breakdown = {}, body = {}, tier) {
  const totalPrice = roundMoney2(breakdown.totalPrice ?? breakdown.serviceCharge ?? 0);
  const serviceCharge = totalPrice;
  const platformFee = resolvePlatformFeeUsd(breakdown.platformFee, tier);
  const subtotalBeforeTip = roundMoney2(serviceCharge + platformFee);
  const tipAmount =
    breakdown.tipAmount != null && Number.isFinite(Number(breakdown.tipAmount))
      ? roundMoney2(Math.max(0, Number(breakdown.tipAmount)))
      : parseTipAmount(subtotalBeforeTip, body);
  const paypalTotal = roundMoney2(subtotalBeforeTip + tipAmount);
  const totalAmount = roundMoney2(totalPrice + platformFee);
  return {
    ...breakdown,
    totalPrice,
    depositAmount: 0,
    serviceCharge,
    platformFee,
    subtotalBeforeTip,
    tipAmount,
    paypalTotal,
    totalAmount,
    paymentType: "full",
  };
}

/** Deposits are disabled platform-wide. */
export function depositEnabled() {
  return false;
}

/** @deprecated deposits removed */
export function depositsAllowedForBooking(_opts = {}) {
  return false;
}

/** @deprecated deposits removed */
export function depositForStylePrice(_stylePrice) {
  return 0;
}

const TIP_PRESETS = new Set([5, 10, 15]);

export function parseTipAmount(serviceSubtotal, body = {}) {
  const base = roundMoney2(serviceSubtotal);
  const custom = Number(body.tipAmount ?? body.tipUsd ?? body.customTip);
  if (Number.isFinite(custom) && custom > 0) {
    const cap = roundMoney2(Math.max(base * 2, 500));
    return roundMoney2(Math.min(custom, cap));
  }
  const pct = Number(body.tipPercent);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!TIP_PRESETS.has(pct)) return 0;
  return roundMoney2((base * pct) / 100);
}

/**
 * Full service price + platform fee (+ optional tip). Ignores deposit paymentType.
 */
export function computeChargeBreakdown(stylePrice, _paymentType, body = {}, opts = {}) {
  const totalPrice = roundMoney2(stylePrice);
  const serviceCharge = totalPrice;
  const platformFee = resolvePlatformFeeUsd(opts.platformFeeUsd, opts.subscriptionTier);
  const subtotalBeforeTip = roundMoney2(serviceCharge + platformFee);
  const tipAmount = parseTipAmount(subtotalBeforeTip, body);
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
