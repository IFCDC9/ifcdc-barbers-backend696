export const TIER_FREE = "free";
export const TIER_PRO = "pro";
export const TIER_ELITE = "elite";

/** Monthly USD bands (when billing is connected). */
export const TIER_MONTHLY_PRICE_USD = {
  [TIER_FREE]: null,
  [TIER_PRO]: { min: 9.99, max: 19.99 },
  [TIER_ELITE]: { min: 29.99, max: 49.99 },
};

const BILLING_PROVIDERS = new Set(["none", "stripe", "paypal"]);

/**
 * @param {unknown} v
 * @returns {SubscriptionTier}
 */
export function normalizeTier(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === TIER_PRO || s === "tier2" || s === "2") return TIER_PRO;
  if (s === TIER_ELITE || s === "tier3" || s === "3") return TIER_ELITE;
  return TIER_FREE;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeBillingProvider(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return BILLING_PROVIDERS.has(s) ? s : "none";
}

/** Pro and Elite get AURA when the barber toggle is on; Free never. */
export function tierAllowsAura(tier) {
  return normalizeTier(tier) !== TIER_FREE;
}

/** Pro and Elite may use booking deposits; Free never. */
export function tierAllowsDeposits(tier) {
  return normalizeTier(tier) !== TIER_FREE;
}

/** Per-booking platform fee charged to customers at checkout (USD). */
export const BARBER_PLATFORM_FEE_USD = 0.99;

/** @deprecated use BARBER_PLATFORM_FEE_USD / platformFeeUsdForTier */
export const PLATFORM_FEE_USD_FREE = 0.99;

function roundMoney2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Customer checkout platform fee (USD) — added to every PayPal total before tip.
 * @param {unknown} _tier — reserved for future tier-specific fees
 */
export function platformFeeUsdForTier(_tier) {
  const env = Number(process.env.PLATFORM_FEE);
  if (Number.isFinite(env) && env > 0) return roundMoney2(env);
  return BARBER_PLATFORM_FEE_USD;
}

/**
 * Optional monthly price: must sit in the tier band when set (pro/elite).
 * @param {SubscriptionTier} tier
 * @param {unknown} monthlyPriceUsd
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateSubscriptionMonthlyPrice(tier, monthlyPriceUsd) {
  const t = normalizeTier(tier);
  if (t === TIER_FREE) {
    if (monthlyPriceUsd != null && monthlyPriceUsd !== "" && Number(monthlyPriceUsd) !== 0) {
      return { ok: false, message: "Free tier cannot have a subscription price." };
    }
    return { ok: true };
  }
  const band = TIER_MONTHLY_PRICE_USD[t];
  if (!band) return { ok: true };
  if (monthlyPriceUsd == null || monthlyPriceUsd === "") return { ok: true };
  const p = Number(monthlyPriceUsd);
  if (!Number.isFinite(p) || p < band.min - 1e-6 || p > band.max + 1e-6) {
    return {
      ok: false,
      message: `Monthly price for ${t} must be between $${band.min} and $${band.max} (or left empty until checkout is enabled).`,
    };
  }
  return { ok: true };
}

/**
 * @param {{ subscription_tier?: unknown, aura_enabled?: boolean }} settings
 * @returns {boolean}
 */
export function barberAuraEffective(settings) {
  const s = settings || {};
  return tierAllowsAura(s.subscription_tier) && Boolean(s.aura_enabled);
}

/**
 * @param {{ subscription_tier?: unknown, booking_deposit_enabled?: boolean }} settings
 * @returns {boolean}
 */
export function barberDepositsEffective(settings) {
  const s = settings || {};
  return tierAllowsDeposits(s.subscription_tier) && Boolean(s.booking_deposit_enabled);
}
