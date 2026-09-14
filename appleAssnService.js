/**
 * Apple App Store Server Notifications v2 + transaction JWS handling.
 * Production verification uses injectable verifier (StoreKit Server API / JWS).
 * Tests inject mocks — never hits App Store.
 */

import { planFromAppleProductId } from "./monetizationCatalog.js";
import {
  mapAppleNotificationToStatus,
  recordSubscriptionEvent,
  upsertVerifiedSubscription,
} from "./entitlementService.js";

function decodeJwtPayloadUnsafe(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function decodeSignedPayloadUnverified(signedPayload) {
  return decodeJwtPayloadUnsafe(signedPayload);
}

/**
 * @param {object} decoded ASSN v2 decoded body { notificationType, subtype, data, notificationUUID }
 */
export function appleTransactionFromDecodedNotification(decoded) {
  const data = decoded?.data || {};
  const txn = data.signedTransactionInfo
    ? decodeJwtPayloadUnsafe(data.signedTransactionInfo)
    : data.transactionInfo || null;
  const renewal = data.signedRenewalInfo
    ? decodeJwtPayloadUnsafe(data.signedRenewalInfo)
    : data.renewalInfo || null;
  return { txn, renewal, data };
}

export function verifiedSubscriptionFromAppleTxn(txn, extras = {}) {
  const productId = String(txn?.productId || extras.productId || "").trim();
  const plan = planFromAppleProductId(productId);
  if (!plan) {
    return { ok: false, error: "unknown_apple_product", productId };
  }
  const statusMapped = extras.statusMapped || "active";
  const status = typeof statusMapped === "string" ? statusMapped : statusMapped.status;
  const cancelAtPeriodEnd =
    typeof statusMapped === "object" ? Boolean(statusMapped.cancelAtPeriodEnd) : Boolean(extras.cancelAtPeriodEnd);
  const autoRenew =
    typeof statusMapped === "object" && statusMapped.autoRenew != null
      ? statusMapped.autoRenew
      : extras.autoRenew !== false;

  const expires = txn?.expiresDate ? new Date(Number(txn.expiresDate)) : extras.expiresDate || null;
  const purchase = txn?.purchaseDate ? new Date(Number(txn.purchaseDate)) : extras.purchaseDate || null;
  const offerType = txn?.offerType != null ? Number(txn.offerType) : null;
  const introUsed = offerType === 1; // introductory

  return {
    ok: true,
    userId: extras.userId || null,
    businessId: extras.businessId || null,
    planKey: plan.planKey,
    source: "apple",
    status,
    storePlatform: "apple",
    storeProductId: productId,
    originalTransactionId: String(txn?.originalTransactionId || extras.originalTransactionId || ""),
    environment: String(txn?.environment || extras.environment || "").toLowerCase() || null,
    currentPeriodStart: purchase,
    currentPeriodEnd: expires,
    trialStartedAt: introUsed ? purchase : null,
    trialEndsAt: extras.trialEndsAt || null,
    autoRenew,
    cancelAtPeriodEnd,
    introUsed,
    metadata: {
      bundleId: txn?.bundleId || null,
      transactionId: txn?.transactionId || null,
      offerType,
      // confirm App Store Connect promotional offer IDs with Tessa
      promotionalOfferId: txn?.offerIdentifier || null,
    },
  };
}

export async function processAppleAssnV2({
  signedPayload,
  dbQuery,
  verifySignedPayload,
  bindUserId = null,
  bindBusinessId = null,
}) {
  if (!signedPayload) {
    return { ok: false, error: "missing_signed_payload" };
  }

  let decoded;
  if (typeof verifySignedPayload === "function") {
    decoded = await verifySignedPayload(signedPayload);
  } else {
    return { ok: false, error: "apple_verifier_required", message: "Never trust unsigned ASSN payloads." };
  }
  if (!decoded || decoded.ok === false) {
    return { ok: false, error: "apple_verify_failed", detail: decoded?.error || null };
  }
  const body = decoded.payload || decoded;
  const { txn } = appleTransactionFromDecodedNotification(body);
  const statusMapped = mapAppleNotificationToStatus(body.notificationType, body.subtype);
  const verified = txn
    ? verifiedSubscriptionFromAppleTxn(txn, {
        userId: bindUserId,
        businessId: bindBusinessId,
        statusMapped,
      })
    : { ok: false, error: "missing_transaction" };

  const notificationUuid = String(body.notificationUUID || body.notificationUuid || "").trim() || null;
  let subRow = null;
  if (verified.ok && dbQuery) {
    subRow = await upsertVerifiedSubscription(dbQuery, verified);
    await recordSubscriptionEvent(dbQuery, {
      accountSubscriptionId: subRow?.id || null,
      userId: bindUserId,
      businessId: bindBusinessId,
      provider: "apple",
      eventType: String(body.notificationType || "ASSN"),
      notificationUuid,
      payload: {
        notificationType: body.notificationType,
        subtype: body.subtype,
        environment: body.data?.environment || txn?.environment,
        originalTransactionId: verified.originalTransactionId,
        productId: verified.storeProductId,
      },
      processed: true,
    });
  } else if (dbQuery) {
    await recordSubscriptionEvent(dbQuery, {
      provider: "apple",
      eventType: String(body.notificationType || "ASSN_unmapped"),
      notificationUuid,
      payload: { error: verified.error || "unmapped" },
      processed: false,
    });
  }

  return { ok: true, verified: verified.ok ? verified : null, notificationType: body.notificationType, subscription: subRow };
}

export async function confirmAppleTransaction({
  transactionJws,
  verifyTransactionJws,
  userId,
  businessId,
  dbQuery,
  claimedProductId,
  claimedStatus,
}) {
  if (claimedStatus) {
    /* ignored — never trust frontend status */
  }
  if (typeof verifyTransactionJws !== "function") {
    return { ok: false, error: "apple_verifier_required" };
  }
  const verifiedJws = await verifyTransactionJws(transactionJws);
  if (!verifiedJws || verifiedJws.ok === false) {
    return { ok: false, error: "apple_verify_failed" };
  }
  const txn = verifiedJws.txn || verifiedJws.payload || verifiedJws;
  const mapped = verifiedSubscriptionFromAppleTxn(txn, { userId, businessId });
  if (!mapped.ok) return mapped;
  if (claimedProductId && String(claimedProductId) !== mapped.storeProductId) {
    return { ok: false, error: "product_mismatch", message: "Client productId does not match verified transaction." };
  }
  let row = null;
  if (dbQuery) row = await upsertVerifiedSubscription(dbQuery, mapped);
  return { ok: true, subscription: row, verified: mapped };
}
