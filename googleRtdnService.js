/**
 * Google Play Real-Time Developer Notifications + purchase token verification.
 * Access SKU is configurable (default ifcdc.barbers.access) — confirm with Tessa before production.
 * Tests inject mocks — never hits Play.
 */

import { googleAccessProductId, planFromGoogleProductId, PRODUCT_TYPES } from "./monetizationCatalog.js";
import {
  mapGoogleRtdnType,
  mapGoogleSubscriptionState,
  recordSubscriptionEvent,
  upsertVerifiedAppAccess,
  upsertVerifiedSubscription,
} from "./entitlementService.js";

export function decodeGoogleRtdnMessage(body) {
  const b64 = body?.message?.data || body?.data;
  if (typeof b64 === "string" && b64.length) {
    try {
      const json = Buffer.from(b64, "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (body?.subscriptionNotification || body?.oneTimeProductNotification) return body;
  return null;
}

export function verifiedFromGoogleSubscriptionPurchase(purchase, extras = {}) {
  const productId = String(extras.productId || purchase?.productId || "").trim();
  const mapped = planFromGoogleProductId(productId);
  if (!mapped || mapped.productType === PRODUCT_TYPES.APP_ACCESS) {
    return { ok: false, error: "unknown_google_subscription_product", productId };
  }
  const stateMapped = mapGoogleSubscriptionState(purchase?.subscriptionState ?? purchase?.paymentState ?? 1);
  const status = typeof stateMapped === "string" ? stateMapped : stateMapped.status;
  const cancelAtPeriodEnd = typeof stateMapped === "object" ? Boolean(stateMapped.cancelAtPeriodEnd) : false;
  const autoRenew = typeof stateMapped === "object" && stateMapped.autoRenew != null ? stateMapped.autoRenew : true;
  const expiry = purchase?.expiryTimeMillis ? new Date(Number(purchase.expiryTimeMillis)) : extras.expiresDate || null;
  const start = purchase?.startTimeMillis ? new Date(Number(purchase.startTimeMillis)) : extras.startDate || null;
  return {
    ok: true,
    userId: extras.userId || null,
    businessId: extras.businessId || null,
    planKey: mapped.planKey,
    source: "google",
    status,
    storePlatform: "google",
    storeProductId: productId,
    originalTransactionId: String(purchase?.orderId || extras.purchaseToken || extras.originalTransactionId || ""),
    purchaseToken: extras.purchaseToken || purchase?.purchaseToken || null,
    environment: extras.environment || null,
    currentPeriodStart: start,
    currentPeriodEnd: expiry,
    autoRenew,
    cancelAtPeriodEnd,
    introUsed: Boolean(purchase?.introductoryPriceInfo),
    metadata: {
      packageName: extras.packageName || null,
      linkedPurchaseToken: purchase?.linkedPurchaseToken || null,
    },
  };
}

export function verifiedGoogleAppAccess(purchase, extras = {}) {
  const productId = String(extras.productId || purchase?.productId || googleAccessProductId()).trim();
  if (productId !== googleAccessProductId()) {
    return {
      ok: false,
      error: "google_access_product_mismatch",
      message: "confirm with Tessa before production",
      expected: googleAccessProductId(),
      got: productId,
    };
  }
  if (purchase?.purchaseState != null && Number(purchase.purchaseState) !== 0) {
    return { ok: false, error: "google_access_not_purchased" };
  }
  return {
    ok: true,
    userId: extras.userId,
    platform: "google",
    productId,
    purchaseToken: extras.purchaseToken || purchase?.purchaseToken,
    originalTransactionId: String(purchase?.orderId || extras.purchaseToken || ""),
    environment: extras.environment || null,
    restored: extras.restored === true,
    metadata: { confirmWithTessaBeforeProduction: true, accountBound: true, consumable: false },
  };
}

export async function processGoogleRtdn({
  body,
  dbQuery,
  verifySubscription,
  verifyOneTime,
  bindUserId = null,
  bindBusinessId = null,
}) {
  const decoded = decodeGoogleRtdnMessage(body);
  if (!decoded) return { ok: false, error: "invalid_rtdn" };

  const subN = decoded.subscriptionNotification;
  const otpN = decoded.oneTimeProductNotification;
  const testN = decoded.testNotification;

  if (testN) {
    if (dbQuery) {
      await recordSubscriptionEvent(dbQuery, {
        provider: "google",
        eventType: "TEST_NOTIFICATION",
        notificationUuid: `google-test-${Date.now()}`,
        payload: { test: true },
        processed: true,
      });
    }
    return { ok: true, test: true };
  }

  if (subN) {
    const productId = String(subN.subscriptionId || "").trim();
    const purchaseToken = String(subN.purchaseToken || "").trim();
    const eventType = mapGoogleRtdnType(subN.notificationType);
    if (typeof verifySubscription !== "function") {
      return { ok: false, error: "google_verifier_required" };
    }
    const purchase = await verifySubscription({ productId, purchaseToken, packageName: decoded.packageName });
    if (!purchase || purchase.ok === false) return { ok: false, error: "google_verify_failed" };
    const mapped = verifiedFromGoogleSubscriptionPurchase(purchase.purchase || purchase, {
      productId,
      purchaseToken,
      packageName: decoded.packageName,
      userId: bindUserId,
      businessId: bindBusinessId,
    });
    if (!mapped.ok) return mapped;
    let row = null;
    if (dbQuery) {
      row = await upsertVerifiedSubscription(dbQuery, mapped);
      await recordSubscriptionEvent(dbQuery, {
        accountSubscriptionId: row?.id,
        userId: bindUserId,
        businessId: bindBusinessId,
        provider: "google",
        eventType,
        notificationUuid: purchaseToken,
        payload: { productId, notificationType: subN.notificationType },
        processed: true,
      });
    }
    return { ok: true, subscription: row, eventType };
  }

  if (otpN) {
    const productId = String(otpN.sku || "").trim();
    const purchaseToken = String(otpN.purchaseToken || "").trim();
    if (typeof verifyOneTime !== "function") {
      return { ok: false, error: "google_verifier_required" };
    }
    const purchase = await verifyOneTime({ productId, purchaseToken, packageName: decoded.packageName });
    if (!purchase || purchase.ok === false) return { ok: false, error: "google_verify_failed" };
    const mapped = verifiedGoogleAppAccess(purchase.purchase || purchase, {
      productId,
      purchaseToken,
      userId: bindUserId,
      packageName: decoded.packageName,
    });
    if (!mapped.ok) return mapped;
    let row = null;
    if (dbQuery && mapped.userId) {
      row = await upsertVerifiedAppAccess(dbQuery, mapped);
    }
    if (dbQuery) {
      await recordSubscriptionEvent(dbQuery, {
        userId: bindUserId,
        provider: "google",
        eventType: "ONE_TIME_PRODUCT",
        notificationUuid: purchaseToken,
        payload: { productId, confirmWithTessaBeforeProduction: true },
        processed: true,
      });
    }
    return { ok: true, appAccess: row, productId };
  }

  return { ok: false, error: "unhandled_rtdn" };
}

export async function confirmGooglePurchase({
  productId,
  purchaseToken,
  packageName,
  userId,
  businessId,
  dbQuery,
  verifySubscription,
  verifyOneTime,
  restored = false,
  claimedStatus,
}) {
  if (claimedStatus) {
    /* ignored */
  }
  const mappedProduct = planFromGoogleProductId(productId);
  if (!mappedProduct) return { ok: false, error: "unknown_google_product" };

  if (mappedProduct.productType === PRODUCT_TYPES.APP_ACCESS) {
    if (typeof verifyOneTime !== "function") return { ok: false, error: "google_verifier_required" };
    const purchase = await verifyOneTime({ productId, purchaseToken, packageName });
    if (!purchase || purchase.ok === false) return { ok: false, error: "google_verify_failed" };
    const mapped = verifiedGoogleAppAccess(purchase.purchase || purchase, {
      productId,
      purchaseToken,
      userId,
      restored,
    });
    if (!mapped.ok) return mapped;
    let row = null;
    if (dbQuery) row = await upsertVerifiedAppAccess(dbQuery, mapped);
    return { ok: true, appAccess: row, verified: mapped };
  }

  if (typeof verifySubscription !== "function") return { ok: false, error: "google_verifier_required" };
  const purchase = await verifySubscription({ productId, purchaseToken, packageName });
  if (!purchase || purchase.ok === false) return { ok: false, error: "google_verify_failed" };
  const mapped = verifiedFromGoogleSubscriptionPurchase(purchase.purchase || purchase, {
    productId,
    purchaseToken,
    packageName,
    userId,
    businessId,
  });
  if (!mapped.ok) return mapped;
  let row = null;
  if (dbQuery) row = await upsertVerifiedSubscription(dbQuery, mapped);
  return { ok: true, subscription: row, verified: mapped };
}
