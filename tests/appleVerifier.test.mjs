import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmAppleTransaction } from "../appleAssnService.js";
import {
  assertAppleTransactionClaims,
  verifySignedTransactionJws,
  verifyStoreKitJws,
} from "../appleJwsVerifier.js";
import {
  appleHealthPublic,
  classifyAppleApiHttpStatus,
  probeAppleStoreKitAuth,
} from "../appleStoreKitClient.js";
import { productionMrrFromSubscriptions } from "../entitlementService.js";
import { entitlementsEnforceEnabled, entitlementsLockShopsEnabled } from "../entitlementFlags.js";
import { getStoreVerifiers, storeVerifyStatus } from "../storeVerifyAdapters.js";

test("invalid JWS is rejected by real verifier", async () => {
  const a = verifyStoreKitJws("not-a-jws");
  assert.equal(a.ok, false);
  assert.equal(a.error, "invalid_jws");
  const b = verifySignedTransactionJws("e30.e30.e30");
  assert.equal(b.ok, false);
  const closed = await confirmAppleTransaction({
    transactionJws: "fake",
    verifyTransactionJws: async (jws) => verifySignedTransactionJws(jws),
  });
  assert.equal(closed.ok, false);
});

test("wrong bundle is rejected", () => {
  const out = assertAppleTransactionClaims({
    bundleId: "com.other.app",
    productId: "ifcdc.barbers.individual.monthly",
    originalTransactionId: "orig-1",
    environment: "Sandbox",
    expiresDate: Date.now() + 86400000,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "wrong_bundle");
});

test("unknown product ID is rejected by claims", () => {
  const out = assertAppleTransactionClaims({
    bundleId: "com.ifcdc.barbers",
    productId: "not.in.catalog",
    originalTransactionId: "orig-1",
    environment: "Sandbox",
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "unknown_apple_product");
});

test("sandbox environment is stored as sandbox", async () => {
  const result = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    verifyTransactionJws: async () => ({
      ok: true,
      txn: {
        bundleId: "com.ifcdc.barbers",
        productId: "ifcdc.barbers.individual.monthly",
        originalTransactionId: "orig-sandbox-1",
        environment: "Sandbox",
        expiresDate: Date.now() + 86400000,
        purchaseDate: Date.now(),
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified.environment, "sandbox");
});

test("duplicate originalTransactionId is idempotent", async () => {
  const ids = [];
  const dbQuery = async (sql, params) => {
    if (String(sql).includes("INSERT INTO account_subscriptions")) {
      const orig = params[7];
      const existing = ids.find((r) => r.store_original_transaction_id === orig);
      if (existing) return { rows: [existing] };
      const row = { id: "sub-same", store_original_transaction_id: orig, plan_key: params[2] };
      ids.push(row);
      return { rows: [row] };
    }
    return { rows: [] };
  };
  const verify = async () => ({
    ok: true,
    txn: {
      bundleId: "com.ifcdc.barbers",
      productId: "ifcdc.barbers.individual.monthly",
      originalTransactionId: "orig-dup",
      environment: "Sandbox",
      expiresDate: Date.now() + 86400000,
    },
  });
  const a = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    verifyTransactionJws: verify,
    dbQuery,
    userId: "11111111-1111-4111-8111-111111111111",
  });
  const b = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    verifyTransactionJws: verify,
    dbQuery,
    userId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.subscription.id, b.subscription.id);
  assert.equal(ids.length, 1);
});

test("catalog appleVerifier is app_store_server not stub", () => {
  const st = storeVerifyStatus();
  assert.equal(st.appleVerifier, "app_store_server");
  assert.notEqual(st.appleVerifier, "stub");
});

test("production path ignores injected stub verifiers", () => {
  const prev = process.env.NODE_TEST;
  const prevCtx = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST;
    delete process.env.NODE_TEST_CONTEXT;
    const v = getStoreVerifiers({
      verifyAppleTransactionJws: async () => ({ ok: true, txn: { productId: "ifcdc.barbers.individual.monthly" } }),
    });
    assert.equal(v.verifyAppleTransactionJws.name, "defaultAppleVerifyTransactionJws");
  } finally {
    if (prev !== undefined) process.env.NODE_TEST = prev;
    else delete process.env.NODE_TEST;
    if (prevCtx !== undefined) process.env.NODE_TEST_CONTEXT = prevCtx;
    else delete process.env.NODE_TEST_CONTEXT;
  }
});

test("Super Admin MRR excludes sandbox", () => {
  const mrr = productionMrrFromSubscriptions([
    {
      plan_key: "individual",
      status: "active",
      store_environment: "sandbox",
      store_platform: "apple",
      current_period_end: "2099-01-01T00:00:00Z",
    },
    {
      plan_key: "shop",
      status: "active",
      store_environment: "production",
      store_platform: "apple",
      current_period_end: "2099-01-01T00:00:00Z",
    },
  ]);
  assert.equal(mrr, 29.99);
});

test("Apple health mock HTTP: 401 fail, 200 pass", async () => {
  const prevI = process.env.APPLE_IAP_ISSUER_ID;
  const prevK = process.env.APPLE_IAP_KEY_ID;
  const prevP = process.env.APPLE_IAP_PRIVATE_KEY;
  process.env.APPLE_IAP_ISSUER_ID = "00000000-0000-4000-8000-000000000001";
  process.env.APPLE_IAP_KEY_ID = "ABCDE12345";
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APPLE_IAP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

  const failProbe = await probeAppleStoreKitAuth({
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => JSON.stringify({ errorCode: 4010000 }) }),
  });
  const failPublic = appleHealthPublic(failProbe);
  assert.equal(failPublic.appleConfigured, true);
  assert.equal(failPublic.appleApiAuth, "fail");
  assert.equal(failPublic.errorClass, "unauthorized");

  const passProbe = await probeAppleStoreKitAuth({
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ testNotificationToken: "omit-me" }) }),
  });
  const passPublic = appleHealthPublic(passProbe);
  assert.equal(passPublic.appleApiAuth, "pass");
  assert.equal(passPublic.environment, "Sandbox");
  assert.equal("testNotificationToken" in passPublic, false);

  if (prevI === undefined) delete process.env.APPLE_IAP_ISSUER_ID;
  else process.env.APPLE_IAP_ISSUER_ID = prevI;
  if (prevK === undefined) delete process.env.APPLE_IAP_KEY_ID;
  else process.env.APPLE_IAP_KEY_ID = prevK;
  if (prevP === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY;
  else process.env.APPLE_IAP_PRIVATE_KEY = prevP;
});

test("401 is unauthorized class not a grant", () => {
  assert.equal(classifyAppleApiHttpStatus(401), "unauthorized");
  assert.equal(classifyAppleApiHttpStatus(403), "forbidden_wrong_key_type");
});

test("ENTITLEMENTS_ENFORCE and LOCK_SHOPS stay off in this process unless set", () => {
  const prevE = process.env.ENTITLEMENTS_ENFORCE;
  const prevL = process.env.ENTITLEMENTS_LOCK_SHOPS;
  delete process.env.ENTITLEMENTS_ENFORCE;
  delete process.env.ENTITLEMENTS_LOCK_SHOPS;
  assert.equal(entitlementsEnforceEnabled(), false);
  assert.equal(entitlementsLockShopsEnabled(), false);
  if (prevE !== undefined) process.env.ENTITLEMENTS_ENFORCE = prevE;
  if (prevL !== undefined) process.env.ENTITLEMENTS_LOCK_SHOPS = prevL;
});
