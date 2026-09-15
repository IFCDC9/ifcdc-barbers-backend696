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
import {
  googlePlayCredentialsConfigured,
  verifyGoogleOneTimePurchase,
  verifyGoogleSubscriptionPurchase,
} from "./googlePlayClient.js";

function googleCredentialsConfigured() {
  return googlePlayCredentialsConfigured();
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

export async function defaultAppleVerifySignedPayload(signedPayload, opts = {}) {
  const verified = verifySignedNotificationJws(signedPayload);
  if (!verified.ok) return verified;
  const txnId = verified.txn?.transactionId || verified.txn?.originalTransactionId;
  if (!appleCredentialsConfigured() || !txnId) return verified;
  const looked = await fetchAppleSignedTransaction({
    transactionId: txnId,
    environment: verified.txn?.environment || verified.payload?.data?.environment,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
  });
  if (!looked.ok) return verified;
  const fromApple = verifySignedTransactionJws(looked.signedTransactionInfo);
  if (!fromApple.ok) return verified;
  return { ...verified, txn: fromApple.txn, appleApiEnvironment: looked.environment };
}

export async function defaultGoogleVerifySubscription(args = {}) {
  return verifyGoogleSubscriptionPurchase(args);
}

export async function defaultGoogleVerifyOneTime(args = {}) {
  return verifyGoogleOneTimePurchase(args);
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
