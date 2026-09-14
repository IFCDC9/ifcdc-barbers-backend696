/**
 * Frozen legacy WRITE paths. Reads and historical rows stay; new store of record is account_subscriptions.
 */

export const LEGACY_WRITE_FROZEN = Object.freeze({
  barberSelfServeTierPatch: {
    path: "PUT /api/barber/settings subscription_tier|subscription_monthly_price|billing_*",
    frozen: true,
    reason: "Self-serve tier PATCH is not App Store / Play Billing. Reads of barber_settings.subscription_tier remain as a legacy mirror.",
  },
  paypalProAsSaas: {
    path: "PayPal custom_id pro: + PAYMENT.CAPTURE.COMPLETED → barber_settings.is_pro",
    frozen: true,
    reason: "PayPal appointment / deposit payments stay. PayPal $9.99 pro: is not the production SaaS subscription. Historical is_pro rows are kept; no account_subscriptions writes from this path.",
  },
  sevenDayStartTrial: {
    path: "POST /api/admin/subscriptions/:barberId/start-trial",
    frozen: true,
    reason: "Do not start 7-day barber_subscriptions trials as a store replacement. Table remains readable.",
  },
  fourteenDayShopTrialAsStore: {
    path: "POST /api/admin/shops/:id/trial/start",
    frozen: true,
    reason: "14-day shop trial must not replace App Store / Play subscriptions. approveShop onboarding trial flags on businesses remain a separate access workflow, not IAP.",
  },
  activateMonthly: {
    path: "POST /api/admin/subscriptions/:barberId/activate-monthly",
    frozen: true,
    reason: "Manual monthly activation is not store billing.",
  },
});

export const LEGACY_FROZEN_CODE = "legacy_write_frozen";

export function legacyWriteFrozenPayload(key) {
  const spec = LEGACY_WRITE_FROZEN[key] || { frozen: true, reason: "Legacy billing write path is frozen." };
  return {
    ok: false,
    error: LEGACY_FROZEN_CODE,
    frozen: true,
    key,
    message: spec.reason,
    path: spec.path || null,
  };
}

export function assertLegacyWriteNotUsed(writeKind) {
  const err = new Error(legacyWriteFrozenPayload(writeKind).message);
  err.code = LEGACY_FROZEN_CODE;
  err.legacyKey = writeKind;
  throw err;
}
