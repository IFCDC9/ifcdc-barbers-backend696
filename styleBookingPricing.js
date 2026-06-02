/**
 * Shared style-based booking charge + tip math (used by PayPal create-order and POST /api/book).
 */
import { BARBER_PLATFORM_FEE_USD, platformFeeUsdForTier } from "./subscriptionTier.js";

export function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function depositEnabled() {
  const v = String(process.env.BOOKING_DEPOSIT_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/** Barber settings override global env when `barberDepositEnabled` is set. */
export function depositsAllowedForBooking(opts = {}) {
  if (opts.barberDepositEnabled === false) return false;
  if (opts.barberDepositEnabled === true) return true;
  return depositEnabled();
}

/** Deposit in USD for a given style full price (never >= style price). */
export function depositForStylePrice(stylePrice) {
  const p = roundMoney2(stylePrice);
  if (!Number.isFinite(p) || p <= 0) return 0.01;
  let dep = Number(process.env.BOOKING_DEPOSIT_USD);
  if (!Number.isFinite(dep) || dep <= 0) dep = roundMoney2(p * 0.4);
  dep = roundMoney2(dep);
  const maxDep = roundMoney2(Math.max(0.01, p - 0.01));
  return Math.min(dep, maxDep);
}

const TIP_PRESETS = new Set([5, 10, 15]);

/**
 * Tip is calculated on the PayPal service subtotal (deposit or full), not on style list price alone when depositing.
 * @param {number} serviceSubtotal - deposit amount or full style price (before tip)
 * @param {object} body - tipPercent and/or tipAmount
 */
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
 * @param {number} stylePrice - from DB styles.price
 * @param {"deposit"|"full"} paymentType
 * @param {object} body - tip fields
 * @param {object} [opts] - optional barber overrides from `loadBarberDepositPricingOpts`
 * @param {boolean} [opts.barberDepositEnabled] - false disables deposits for this barber; true forces allow (if global off, still allow when true)
 * @param {number} [opts.barberDepositAmount] - fixed deposit in USD when > 0
 * @param {number} [opts.platformFeeUsd] - IFCDC platform fee added before tip (Free tier = 0.99)
 */
export function computeChargeBreakdown(stylePrice, paymentType, body = {}, opts = {}) {
  const totalPrice = roundMoney2(stylePrice);
  const globalDep = depositEnabled();
  const barberOn = opts.barberDepositEnabled === true;
  const barberOff = opts.barberDepositEnabled === false;
  const depositsAllowed = barberOff ? false : barberOn ? true : globalDep;

  let depositAmount = depositForStylePrice(totalPrice);
  if (opts.barberDepositAmount != null && Number(opts.barberDepositAmount) > 0) {
    const cap = roundMoney2(Math.max(0.01, totalPrice - 0.01));
    depositAmount = roundMoney2(Math.min(Number(opts.barberDepositAmount), cap));
  }

  const wantDeposit = String(paymentType || "").toLowerCase() === "deposit";
  const useDeposit = depositsAllowed && wantDeposit;
  const serviceCharge = useDeposit ? depositAmount : totalPrice;
  const rawPlatform = Number(opts.platformFeeUsd);
  const platformFee = roundMoney2(
    Number.isFinite(rawPlatform) && rawPlatform > 0 ? rawPlatform : platformFeeUsdForTier(opts.subscriptionTier),
  );
  const subtotalBeforeTip = roundMoney2(serviceCharge + platformFee);
  const tipAmount = parseTipAmount(subtotalBeforeTip, body);
  const paypalTotal = roundMoney2(subtotalBeforeTip + tipAmount);
  /** Service list price + platform fee (excludes tip) — stored on booking for revenue reporting. */
  const totalAmount = roundMoney2(totalPrice + platformFee);
  return {
    totalPrice,
    depositAmount,
    serviceCharge,
    platformFee,
    subtotalBeforeTip,
    totalAmount,
    tipAmount,
    paypalTotal,
    paymentType: useDeposit ? "deposit" : "full",
  };
}
