/**
 * Store verification adapters. Closed by default unless credentials exist.
 * Never print secrets. Tests inject verifiers.
 */

function appleCredentialsConfigured() {
  return Boolean(
    String(process.env.APPLE_IAP_ISSUER_ID || "").trim() &&
      String(process.env.APPLE_IAP_KEY_ID || "").trim() &&
      String(process.env.APPLE_IAP_PRIVATE_KEY || "").trim(),
  );
}

function googleCredentialsConfigured() {
  return Boolean(
    String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim() ||
      String(process.env.GOOGLE_PLAY_ACCESS_TOKEN || "").trim(),
  );
}

export function storeVerifyStatus() {
  return {
    appleConfigured: appleCredentialsConfigured(),
    googleConfigured: googleCredentialsConfigured(),
    note: "Production confirm/webhooks require Tessa-provisioned keys. Unconfigured verifiers refuse grants.",
  };
}

export async function defaultAppleVerifySignedPayload() {
  return { ok: false, error: "apple_credentials_not_configured" };
}

export async function defaultAppleVerifyTransactionJws() {
  return { ok: false, error: "apple_credentials_not_configured" };
}

export async function defaultGoogleVerifySubscription() {
  return { ok: false, error: "google_credentials_not_configured" };
}

export async function defaultGoogleVerifyOneTime() {
  return { ok: false, error: "google_credentials_not_configured" };
}

export function getStoreVerifiers(overrides = {}) {
  return {
    verifyAppleSignedPayload: overrides.verifyAppleSignedPayload || defaultAppleVerifySignedPayload,
    verifyAppleTransactionJws: overrides.verifyAppleTransactionJws || defaultAppleVerifyTransactionJws,
    verifyGoogleSubscription: overrides.verifyGoogleSubscription || defaultGoogleVerifySubscription,
    verifyGoogleOneTime: overrides.verifyGoogleOneTime || defaultGoogleVerifyOneTime,
  };
}
