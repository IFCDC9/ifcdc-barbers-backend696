import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmAppleTransaction, processAppleAssnV2, verifiedSubscriptionFromAppleTxn } from "../appleAssnService.js";
import { confirmGooglePurchase, processGoogleRtdn } from "../googleRtdnService.js";
import { mapAppleNotificationToStatus } from "../entitlementService.js";
import { defaultAppleVerifyTransactionJws } from "../storeVerifyAdapters.js";

function memoryDb() {
  const rows = [];
  const events = [];
  return async function dbQuery(sql, params) {
    const text = String(sql);
    if (text.includes("FROM subscription_events") && text.includes("notification_uuid")) {
      const uuid = params[0];
      const found = events.find((e) => e.uuid === uuid);
      return { rows: found ? [{ id: found.id }] : [] };
    }
    if (text.includes("INSERT INTO account_subscriptions")) {
      const orig = params[7];
      const existing = rows.find((r) => r.store_original_transaction_id === orig && orig);
      if (existing) {
        existing.user_id = params[0] || existing.user_id;
        existing.business_id = params[1] || existing.business_id;
        existing.plan_key = params[2];
        existing.status = params[4];
        existing.store_product_id = params[6];
        existing.store_environment = params[9];
        return { rows: [existing] };
      }
      const row = {
        id: `sub-${rows.length + 1}`,
        user_id: params[0],
        business_id: params[1],
        plan_key: params[2],
        source: params[3],
        status: params[4],
        store_platform: params[5],
        store_product_id: params[6],
        store_original_transaction_id: params[7],
        store_environment: params[9],
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (text.includes("INSERT INTO app_access_entitlements")) {
      const row = { id: "access-1", user_id: params[0], product_id: params[2], status: "granted" };
      return { rows: [row] };
    }
    if (text.includes("INSERT INTO subscription_events")) {
      const uuid = params[5];
      if (uuid && events.some((e) => e.uuid === uuid)) {
        return { rows: [] };
      }
      const rec = { id: `evt-${events.length + 1}`, uuid, sql, params };
      events.push(rec);
      return { rows: [{ id: rec.id }] };
    }
    return { rows: [] };
  };
}

test("never trust frontend status on Apple confirm", async () => {
  const dbQuery = memoryDb();
  const result = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    claimedStatus: "active",
    claimedProductId: "ifcdc.barbers.individual.monthly",
    userId: "11111111-1111-4111-8111-111111111111",
    dbQuery,
    verifyTransactionJws: async () => ({
      ok: true,
      txn: {
        productId: "ifcdc.barbers.individual.monthly",
        originalTransactionId: "orig-1",
        expiresDate: Date.now() + 86400000,
        environment: "Sandbox",
        bundleId: "com.ifcdc.barbers",
        offerType: 1,
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified.status, "active");
  assert.equal(result.verified.planKey, "individual");
  assert.equal(result.verified.introUsed, true);
});

test("Apple confirm rejects unknown product IDs", async () => {
  const result = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    verifyTransactionJws: async () => ({
      ok: true,
      txn: { productId: "invented.sku", originalTransactionId: "x", bundleId: "com.ifcdc.barbers", environment: "Sandbox" },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_apple_product");
});

test("Apple confirm rejects unverified JWS", async () => {
  const closed = await defaultAppleVerifyTransactionJws();
  assert.equal(closed.ok, false);
  const result = await confirmAppleTransaction({
    verifyTransactionJws: defaultAppleVerifyTransactionJws,
    transactionJws: "fake",
  });
  assert.equal(result.ok, false);
});

test("ASSN v2 upgrade DID_CHANGE_RENEWAL_PREF maps to new product", async () => {
  assert.equal(mapAppleNotificationToStatus("DID_CHANGE_RENEWAL_PREF"), "active");
  const mapped = verifiedSubscriptionFromAppleTxn(
    { productId: "ifcdc.barbers.multilocation.monthly", originalTransactionId: "orig-up" },
    { statusMapped: "active" },
  );
  assert.equal(mapped.planKey, "multilocation");
});

test("ASSN v2 expire does not delete — status expired", async () => {
  assert.equal(mapAppleNotificationToStatus("EXPIRED"), "expired");
  const dbQuery = memoryDb();
  const payload = {
    notificationType: "EXPIRED",
    notificationUUID: "uuid-1",
    data: {
      signedTransactionInfo: Buffer.from(
        JSON.stringify({
          productId: "ifcdc.barbers.shop.monthly",
          originalTransactionId: "orig-shop",
          expiresDate: Date.now() - 1000,
          bundleId: "com.ifcdc.barbers",
          environment: "Sandbox",
        }),
      )
        .toString("base64url"),
    },
  };
  payload.data.signedTransactionInfo = `e30.${payload.data.signedTransactionInfo}.x`;
  const signedPayload = `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
  const out = await processAppleAssnV2({
    signedPayload,
    dbQuery,
    verifySignedPayload: async () => ({ ok: true, payload }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.verified.status, "expired");
  assert.equal(out.subscription.plan_key, "shop");
});

test("Google RTDN subscription purchase mocked", async () => {
  const dbQuery = memoryDb();
  const inner = {
    subscriptionNotification: {
      notificationType: 4,
      purchaseToken: "token-sub",
      subscriptionId: "ifcdc.barbers.shop.monthly",
    },
    packageName: "com.ifcdc.barbers",
  };
  const body = { message: { data: Buffer.from(JSON.stringify(inner)).toString("base64") } };
  const out = await processGoogleRtdn({
    body,
    dbQuery,
    verifySubscription: async () => ({
      ok: true,
      purchase: {
        subscriptionState: 1,
        expiryTimeMillis: Date.now() + 86400000,
        orderId: "GPA.123",
      },
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.subscription.plan_key, "shop");
});

test("Google one-time access confirm — confirm with Tessa product id", async () => {
  const dbQuery = memoryDb();
  const out = await confirmGooglePurchase({
    productId: "ifcdc.barbers.access",
    purchaseToken: "otp-1",
    packageName: "com.ifcdc.barbers",
    userId: "11111111-1111-4111-8111-111111111111",
    dbQuery,
    claimedStatus: "owned",
    verifyOneTime: async () => ({ ok: true, purchase: { purchaseState: 0, orderId: "order-access" } }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.verified.productId, "ifcdc.barbers.access");
  assert.equal(out.appAccess.status, "granted");
});

test("Google confirm does not hit Play when verifier is mock-only", async () => {
  const out = await confirmGooglePurchase({
    productId: "ifcdc.barbers.individual.monthly",
    purchaseToken: "no-live",
    verifySubscription: async () => ({
      ok: true,
      purchase: { subscriptionState: 1, expiryTimeMillis: Date.now() + 10000, orderId: "GPA.x" },
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.verified.planKey, "individual");
});
