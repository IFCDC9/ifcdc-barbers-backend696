/**
 * Entitlement enforcement is off by default so booking, PayPal, AURA, and shops keep working.
 * Tessa must authorize ENTITLEMENTS_ENFORCE=1 and ENTITLEMENTS_LOCK_SHOPS=1 before paid gates lock shops.
 */

export function entitlementsEnforceEnabled() {
  const v = String(process.env.ENTITLEMENTS_ENFORCE || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Second gate — even with ENFORCE=1, shops are not locked unless this is on. */
export function entitlementsLockShopsEnabled() {
  if (!entitlementsEnforceEnabled()) return false;
  const v = String(process.env.ENTITLEMENTS_LOCK_SHOPS || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function entitlementsMode() {
  if (entitlementsLockShopsEnabled()) return "enforce_lock_shops";
  if (entitlementsEnforceEnabled()) return "enforce_observe_no_shop_lock";
  return "observe_sandbox";
}
