/**
 * Store verification adapters. Production always uses App Store Server API + JWS x5c.
 * Tests may inject mocks only when NODE_TEST / NODE_TEST_CONTEXT is set.
 * Credential presence never grants entitlements.
 */

import {
  appleCredentialsConfigured,
  fetchAppleSignedTransaction,
  probeAppleStoreKitAuth,
} from "./appleStoreKitClient.js";
import { verifySignedNotificationJws, verifySignedTransactionJws } from "./appleJwsVerifier.js";

function googleCredentialsConfigured() {
  return Boolean(
    String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim() ||
      String(process.env.GOOGLE_PLAY_ACCESS_TOKEN || "").trim(),
  );
}

function testInjectionAllowed() {
  return Boolean(process.env.NODE_TEST) || Boolean(process.env.NODE_TEST_CONTEXT);
}

export function appleVerifierName() {
  return "app_store_server";
}

export function storeVerifyStatus() {
  return {
    appleConfigured: appleCredentialsConfigured(),
    googleConfigured: googleCredentialsConfigured(),
    appleVerifier: appleVerifierName(),
    googleVerifier: googleCredentialsConfigured() ? "play_developer_api" : "closed",
    note: "Grants require verified Apple JWS + App Store Server lookup. Credentials alone never grant.",
  };
}

export async function defaultAppleVerifyTransactionJws(jws, opts = {}) {
  const local = verifySignedTransactionJws(jws);
  if (!local.ok) return local;
  if (!appleCredentialsConfigured()) {
    return { ok: false, error: "apple_credentials_not_configured" };
  }
  const looked = await fetchAppleSignedTransaction({
    transactionId: local.txn.transactionId || local.txn.originalTransactionId,
    environment: local.txn.environment,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
  });
  if (!looked.ok) return looked;
  const fromApple = verifySignedTransactionJws(looked.signedTransactionInfo);
  if (!fromApple.ok) return fromApple;
  return { ok: true, txn: fromApple.txn };
}

export async function defaultAppleVerifySignedPayload(signedPayload) {
  return verifySignedNotificationJws(signedPayload);
}

export async function defaultGoogleVerifySubscription() {
  return { ok: false, error: "google_credentials_not_configured" };
}

export async function defaultGoogleVerifyOneTime() {
  return { ok: false, error: "google_credentials_not_configured" };
}

export function getStoreVerifiers(overrides = {}) {
  const inject = testInjectionAllowed();
  return {
    verifyAppleSignedPayload:
      (inject && overrides.verifyAppleSignedPayload) || defaultAppleVerifySignedPayload,
    verifyAppleTransactionJws:
      (inject && overrides.verifyAppleTransactionJws) || defaultAppleVerifyTransactionJws,
    verifyGoogleSubscription:
      (inject && overrides.verifyGoogleSubscription) || defaultGoogleVerifySubscription,
    verifyGoogleOneTime: (inject && overrides.verifyGoogleOneTime) || defaultGoogleVerifyOneTime,
  };
}

export { appleCredentialsConfigured, probeAppleStoreKitAuth };
