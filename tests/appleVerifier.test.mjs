import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmAppleTransaction } from "../appleAssnService.js";
import {
  assertAppleTransactionClaims,
  verifySignedTransactionJws,
  verifyStoreKitJws,
} from "../appleJwsVerifier.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appleHealthPublic,
  appleIapKeyFileCandidates,
  appleApiBasesToTry,
  APPLE_IAP_DEFAULT_PRIVATE_KEY_FILE,
  APPLE_IAP_SECRET_FILE_NAME,
  APPLE_STOREKIT_PRODUCTION,
  APPLE_STOREKIT_SANDBOX,
  classifyAppleApiHttpStatus,
  fetchAppleSignedTransaction,
  inspectAppleSigningKey,
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

test("production environment is stored as production", async () => {
  const result = await confirmAppleTransaction({
    transactionJws: "aaa.bbb.ccc",
    verifyTransactionJws: async () => ({
      ok: true,
      txn: {
        bundleId: "com.ifcdc.barbers",
        productId: "ifcdc.barbers.individual.monthly",
        originalTransactionId: "orig-prod-1",
        environment: "Production",
        expiresDate: Date.now() + 86400000,
        purchaseDate: Date.now(),
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified.environment, "production");
});

test("Production environment uses production StoreKit host first, then sandbox", () => {
  const prod = appleApiBasesToTry("Production");
  assert.equal(prod[0].base, APPLE_STOREKIT_PRODUCTION);
  assert.equal(prod[1].base, APPLE_STOREKIT_SANDBOX);
  const sand = appleApiBasesToTry("Sandbox");
  assert.equal(sand[0].base, APPLE_STOREKIT_SANDBOX);
  assert.equal(sand[1].base, APPLE_STOREKIT_PRODUCTION);
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
  const prevF = process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  process.env.APPLE_IAP_ISSUER_ID = "00000000-0000-4000-8000-000000000001";
  process.env.APPLE_IAP_KEY_ID = "ABCDE12345";
  delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
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
  assert.equal(failPublic.keySource, "env");
  assert.equal(failPublic.keyParse, "pass");
  assert.equal(failPublic.keyFileEnvSet, false);
  assert.equal(failPublic.keyFileExists, false);

  const passProbe = await probeAppleStoreKitAuth({
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ testNotificationToken: "omit-me" }) }),
  });
  const passPublic = appleHealthPublic(passProbe);
  assert.equal(passPublic.appleApiAuth, "pass");
  assert.equal(passPublic.environment, "Sandbox");
  assert.equal(passPublic.keySource, "env");
  assert.equal(passPublic.keyParse, "pass");
  assert.equal("testNotificationToken" in passPublic, false);

  if (prevI === undefined) delete process.env.APPLE_IAP_ISSUER_ID;
  else process.env.APPLE_IAP_ISSUER_ID = prevI;
  if (prevK === undefined) delete process.env.APPLE_IAP_KEY_ID;
  else process.env.APPLE_IAP_KEY_ID = prevK;
  if (prevP === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY;
  else process.env.APPLE_IAP_PRIVATE_KEY = prevP;
  if (prevF === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  else process.env.APPLE_IAP_PRIVATE_KEY_FILE = prevF;
});

test("flattened PKCS8 EC P-256 PEM still inspects as ec", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { inspectAppleSigningKey, normalizeApplePrivateKey } = await import("../appleStoreKitClient.js");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const flat = pem.replace(/\n/g, "");
  const restored = normalizeApplePrivateKey(flat);
  assert.match(restored, /BEGIN PRIVATE KEY/);
  const prev = process.env.APPLE_IAP_PRIVATE_KEY;
  const prevF = process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  process.env.APPLE_IAP_PRIVATE_KEY = flat;
  delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  const shape = inspectAppleSigningKey();
  assert.equal(shape.ok, true);
  assert.equal(shape.keyType, "ec");
  if (prev === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY;
  else process.env.APPLE_IAP_PRIVATE_KEY = prev;
  if (prevF === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  else process.env.APPLE_IAP_PRIVATE_KEY_FILE = prevF;
});

test("401 is unauthorized class not a grant", () => {
  assert.equal(classifyAppleApiHttpStatus(401), "unauthorized");
  assert.equal(classifyAppleApiHttpStatus(403), "forbidden_wrong_key_type");
});

test("Apple IAP file candidates include default and basename mounts", () => {
  const fileEnv = "/etc/secrets/ifcdc-barbers-iap.p8";
  const candidates = appleIapKeyFileCandidates(fileEnv);
  assert.equal(candidates.includes(fileEnv), true);
  assert.equal(candidates.includes(APPLE_IAP_DEFAULT_PRIVATE_KEY_FILE), true);
  assert.equal(candidates.includes(`/etc/secrets/${APPLE_IAP_SECRET_FILE_NAME}`), true);
  assert.equal(candidates.includes(`/etc/secrets/${path.basename(fileEnv)}`), true);
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

function restoreAppleKeyEnv(prev) {
  for (const [key, val] of Object.entries(prev)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

test("APPLE_IAP_PRIVATE_KEY_FILE is preferred over env PKCS8", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const dir = mkdtempSync(path.join(tmpdir(), "apple-iap-"));
  const filePath = path.join(dir, "ifcdc-barbers-iap.p8");
  writeFileSync(filePath, pem);
  const prev = {
    APPLE_IAP_PRIVATE_KEY: process.env.APPLE_IAP_PRIVATE_KEY,
    APPLE_IAP_PRIVATE_KEY_FILE: process.env.APPLE_IAP_PRIVATE_KEY_FILE,
  };
  try {
    process.env.APPLE_IAP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
    process.env.APPLE_IAP_PRIVATE_KEY_FILE = filePath;
    const shape = inspectAppleSigningKey();
    assert.equal(shape.keySource, "file");
    assert.equal(shape.keyParse, "pass");
    assert.equal(shape.ok, true);
    assert.equal(shape.keyType, "ec");
    assert.equal(shape.keyFileEnvSet, true);
    assert.equal(shape.keyFileExists, true);
    const publicHealth = appleHealthPublic({
      appleConfigured: true,
      appleApiAuth: "pass",
      keySource: shape.keySource,
      keyParse: shape.keyParse,
      keyFileEnvSet: shape.keyFileEnvSet,
      keyFileExists: shape.keyFileExists,
      environment: "Sandbox",
    });
    assert.equal(publicHealth.keySource, "file");
    assert.equal(publicHealth.keyFileEnvSet, true);
    assert.equal(publicHealth.keyFileExists, true);
    assert.equal("errorClass" in publicHealth, false);
  } finally {
    restoreAppleKeyEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("APPLE_IAP_PRIVATE_KEY_FILE set but missing does not use env fallback", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { loadAppleIapPrivateKey } = await import("../appleStoreKitClient.js");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const prev = {
    APPLE_IAP_PRIVATE_KEY: process.env.APPLE_IAP_PRIVATE_KEY,
    APPLE_IAP_PRIVATE_KEY_FILE: process.env.APPLE_IAP_PRIVATE_KEY_FILE,
  };
  try {
    process.env.APPLE_IAP_PRIVATE_KEY = pem;
    process.env.APPLE_IAP_PRIVATE_KEY_FILE = path.join(tmpdir(), "missing-ifcdc-barbers-iap.p8");
    const loaded = loadAppleIapPrivateKey();
    assert.equal(loaded.source, "file");
    assert.equal(String(loaded.raw || "").trim(), "");
    assert.equal(loaded.errorClass, "file_not_found");
    const shape = inspectAppleSigningKey(loaded);
    assert.equal(shape.keySource, "file");
    assert.equal(shape.keyParse, "fail");
    assert.equal(shape.ok, false);
    assert.equal(shape.errorClass, "file_not_found");
    assert.equal(shape.keyFileEnvSet, true);
    assert.equal(shape.keyFileExists, false);
    const publicHealth = appleHealthPublic({
      appleConfigured: false,
      appleApiAuth: "fail",
      keySource: shape.keySource,
      keyParse: shape.keyParse,
      keyFileEnvSet: shape.keyFileEnvSet,
      keyFileExists: shape.keyFileExists,
      keyFileTriedNames: loaded.triedNames,
      environment: "unconfigured",
      errorClass: shape.errorClass,
    });
    assert.equal(publicHealth.keySource, "file");
    assert.equal(publicHealth.keyFileEnvSet, true);
    assert.equal(publicHealth.keyFileExists, false);
    assert.equal(publicHealth.errorClass, "file_not_found");
    assert.equal(JSON.stringify(publicHealth).includes(pem.slice(0, 20)), false);
    assert.equal(JSON.stringify(publicHealth).includes("BEGIN PRIVATE KEY"), false);
    for (const name of publicHealth.keyFileTriedNames || []) {
      assert.equal(name.includes("/"), false);
    }
  } finally {
    restoreAppleKeyEnv(prev);
  }
});

test("invalid secret file fails parse without leaking key material", async () => {
  const marker = "LEAK_MARKER_NOT_A_KEY_9f3c";
  const dir = mkdtempSync(path.join(tmpdir(), "apple-iap-bad-"));
  const filePath = path.join(dir, "ifcdc-barbers-iap.p8");
  writeFileSync(filePath, `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`);
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const prev = {
    APPLE_IAP_ISSUER_ID: process.env.APPLE_IAP_ISSUER_ID,
    APPLE_IAP_KEY_ID: process.env.APPLE_IAP_KEY_ID,
    APPLE_IAP_PRIVATE_KEY: process.env.APPLE_IAP_PRIVATE_KEY,
    APPLE_IAP_PRIVATE_KEY_FILE: process.env.APPLE_IAP_PRIVATE_KEY_FILE,
  };
  try {
    process.env.APPLE_IAP_ISSUER_ID = "00000000-0000-4000-8000-000000000001";
    process.env.APPLE_IAP_KEY_ID = "ABCDE12345";
    process.env.APPLE_IAP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
    process.env.APPLE_IAP_PRIVATE_KEY_FILE = filePath;
    const shape = inspectAppleSigningKey();
    assert.equal(shape.keySource, "file");
    assert.equal(shape.keyParse, "fail");
    assert.equal(shape.ok, false);
    assert.equal(shape.errorClass, "private_key_unreadable");
    const publicHealth = appleHealthPublic({
      appleConfigured: true,
      appleApiAuth: "fail",
      keySource: shape.keySource,
      keyParse: shape.keyParse,
      keyFileEnvSet: true,
      keyFileExists: true,
      environment: "Sandbox",
      errorClass: shape.errorClass,
    });
    assert.equal(publicHealth.keyFileEnvSet, true);
    assert.equal(publicHealth.keyFileExists, true);
    const dumped = JSON.stringify(publicHealth);
    assert.equal(dumped.includes(marker), false);
    assert.equal(dumped.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(dumped.includes(filePath), false);
    assert.equal(publicHealth.keySource, "file");
    assert.equal(publicHealth.keyParse, "fail");
  } finally {
    restoreAppleKeyEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Production transaction lookup tries production host then sandbox on 404", async () => {
  const prevI = process.env.APPLE_IAP_ISSUER_ID;
  const prevK = process.env.APPLE_IAP_KEY_ID;
  const prevP = process.env.APPLE_IAP_PRIVATE_KEY;
  const prevF = process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  process.env.APPLE_IAP_ISSUER_ID = "00000000-0000-4000-8000-000000000001";
  process.env.APPLE_IAP_KEY_ID = "ABCDE12345";
  delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APPLE_IAP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  const urls = [];
  const looked = await fetchAppleSignedTransaction({
    transactionId: "txn-prod-lookup",
    environment: "Production",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("api.storekit.apple.com") && !String(url).includes("sandbox")) {
        return { status: 404, ok: false, text: async () => "{}" };
      }
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ signedTransactionInfo: "e30.e30.e30" }),
      };
    },
  });
  assert.equal(looked.ok, true);
  assert.equal(looked.environment, "Sandbox");
  assert.equal(urls[0].startsWith(APPLE_STOREKIT_PRODUCTION), true);
  assert.equal(urls.some((u) => u.startsWith(APPLE_STOREKIT_SANDBOX)), true);
  if (prevI === undefined) delete process.env.APPLE_IAP_ISSUER_ID;
  else process.env.APPLE_IAP_ISSUER_ID = prevI;
  if (prevK === undefined) delete process.env.APPLE_IAP_KEY_ID;
  else process.env.APPLE_IAP_KEY_ID = prevK;
  if (prevP === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY;
  else process.env.APPLE_IAP_PRIVATE_KEY = prevP;
  if (prevF === undefined) delete process.env.APPLE_IAP_PRIVATE_KEY_FILE;
  else process.env.APPLE_IAP_PRIVATE_KEY_FILE = prevF;
});
