/**
 * App Store Server API client (JWT ES256). Never logs keys, JWS, or bearer tokens.
 */

import jwt from "jsonwebtoken";
import { APPLE_BUNDLE_ID } from "./monetizationCatalog.js";

export const APPLE_STOREKIT_SANDBOX = "https://api.storekit-sandbox.apple.com";
export const APPLE_STOREKIT_PRODUCTION = "https://api.storekit.apple.com";

export function appleCredentialsConfigured() {
  return Boolean(
    String(process.env.APPLE_IAP_ISSUER_ID || "").trim() &&
      String(process.env.APPLE_IAP_KEY_ID || "").trim() &&
      String(process.env.APPLE_IAP_PRIVATE_KEY || "").trim(),
  );
}

export function normalizeApplePrivateKey(raw) {
  let s = String(raw || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (!s) return "";
  if (!s.includes("BEGIN")) {
    const body = s.replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) || [body];
    s = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return s;
}

export function appleApiBaseForEnvironment(environment) {
  const env = String(environment || "").toLowerCase();
  if (env === "production") return APPLE_STOREKIT_PRODUCTION;
  return APPLE_STOREKIT_SANDBOX;
}

export function classifyAppleApiHttpStatus(status, errorCode) {
  const n = Number(status);
  if (n === 401) return "unauthorized";
  if (n === 403) return "forbidden_wrong_key_type";
  if (n === 404) return "not_found";
  if (n === 405) return "method_not_allowed";
  if (n === 429) return "rate_limited";
  if (n >= 500) return "apple_unavailable";
  if (errorCode != null && String(errorCode).trim()) return `apple_error_${errorCode}`;
  if (n >= 400) return `http_${n}`;
  return "ok";
}

export function classifyJwtSignError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("asymmetric") || msg.includes("es256") || msg.includes("ec")) {
    return "private_key_not_ec_p256";
  }
  if (msg.includes("secretorprivatekey") || msg.includes("pem") || msg.includes("key")) {
    return "private_key_invalid";
  }
  return "jwt_sign_failed";
}

export function createAppStoreServerApiJwt() {
  if (!appleCredentialsConfigured()) {
    return { ok: false, errorClass: "not_configured" };
  }
  const issuerId = String(process.env.APPLE_IAP_ISSUER_ID || "").trim();
  const keyId = String(process.env.APPLE_IAP_KEY_ID || "").trim();
  const signingKey = normalizeApplePrivateKey(process.env.APPLE_IAP_PRIVATE_KEY);
  if (!signingKey) return { ok: false, errorClass: "private_key_invalid" };
  try {
    const token = jwt.sign(
      { bid: APPLE_BUNDLE_ID },
      signingKey,
      {
        algorithm: "ES256",
        keyid: keyId,
        issuer: issuerId,
        audience: "appstoreconnect-v1",
        expiresIn: "5m",
        header: { typ: "JWT", alg: "ES256", kid: keyId },
      },
    );
    return { ok: true, token };
  } catch (err) {
    return { ok: false, errorClass: classifyJwtSignError(err) };
  }
}

async function appleFetch(fetchImpl, url, init) {
  const ctrl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  return fetchImpl(url, { ...init, signal: ctrl });
}

async function parseAppleJsonSafe(res) {
  try {
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Auth probe: GET sandbox notifications/test, POST if GET is not allowed.
 * Success is any authenticated response (not 401/403). Never returns tokens.
 */
export async function probeAppleStoreKitAuth({ fetchImpl = globalThis.fetch } = {}) {
  if (!appleCredentialsConfigured()) {
    return {
      appleConfigured: false,
      appleApiAuth: "fail",
      environment: "unconfigured",
      errorClass: "not_configured",
    };
  }
  const signed = createAppStoreServerApiJwt();
  if (!signed.ok) {
    return {
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: signed.errorClass,
    };
  }
  const headers = {
    Authorization: `Bearer ${signed.token}`,
    Accept: "application/json",
  };
  const sandboxUrl = `${APPLE_STOREKIT_SANDBOX}/inApps/v1/notifications/test`;
  try {
    const getRes = await appleFetch(fetchImpl, sandboxUrl, { method: "GET", headers });
    if (getRes.status === 401 || getRes.status === 403) {
      const body = await parseAppleJsonSafe(getRes);
      return {
        appleConfigured: true,
        appleApiAuth: "fail",
        environment: "Sandbox",
        errorClass: classifyAppleApiHttpStatus(getRes.status, body.errorCode),
        appleErrorCode: body.errorCode ?? null,
      };
    }
    if (getRes.status === 405 || getRes.status === 404) {
      const postRes = await appleFetch(fetchImpl, sandboxUrl, { method: "POST", headers });
      if (postRes.status === 401 || postRes.status === 403) {
        const body = await parseAppleJsonSafe(postRes);
        return {
          appleConfigured: true,
          appleApiAuth: "fail",
          environment: "Sandbox",
          errorClass: classifyAppleApiHttpStatus(postRes.status, body.errorCode),
          appleErrorCode: body.errorCode ?? null,
        };
      }
      if (postRes.ok || postRes.status === 202) {
        return { appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox" };
      }
      const body = await parseAppleJsonSafe(postRes);
      if (postRes.status === 401 || postRes.status === 403) {
        return {
          appleConfigured: true,
          appleApiAuth: "fail",
          environment: "Sandbox",
          errorClass: classifyAppleApiHttpStatus(postRes.status, body.errorCode),
        };
      }
      /* Authenticated but unexpected status — still proves JWT accepted if not 401/403 */
      if (postRes.status !== 401 && postRes.status !== 403) {
        return { appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox" };
      }
    }
    if (getRes.ok || getRes.status === 202) {
      return { appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox" };
    }
    if (getRes.status !== 401 && getRes.status !== 403) {
      return { appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox" };
    }
    return {
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: classifyAppleApiHttpStatus(getRes.status),
    };
  } catch (err) {
    const msg = String(err?.name || err?.message || "network_error");
    return {
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: msg === "TimeoutError" ? "apple_timeout" : "apple_network_error",
    };
  }
}

export async function fetchAppleSignedTransaction({
  transactionId,
  environment,
  fetchImpl = globalThis.fetch,
}) {
  if (!appleCredentialsConfigured()) {
    return { ok: false, error: "apple_credentials_not_configured", errorClass: "not_configured" };
  }
  const id = String(transactionId || "").trim();
  if (!id) return { ok: false, error: "missing_transaction_id" };
  const signed = createAppStoreServerApiJwt();
  if (!signed.ok) {
    return { ok: false, error: "apple_jwt_failed", errorClass: signed.errorClass };
  }
  const base = appleApiBaseForEnvironment(environment);
  const url = `${base}/inApps/v1/transactions/${encodeURIComponent(id)}`;
  try {
    const res = await appleFetch(fetchImpl, url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${signed.token}`,
        Accept: "application/json",
      },
    });
    const body = await parseAppleJsonSafe(res);
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "apple_api_auth_failed",
        errorClass: classifyAppleApiHttpStatus(res.status, body.errorCode),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: "apple_lookup_failed",
        errorClass: classifyAppleApiHttpStatus(res.status, body.errorCode),
      };
    }
    const signedTransactionInfo = body.signedTransactionInfo;
    if (!signedTransactionInfo) {
      return { ok: false, error: "apple_lookup_missing_transaction" };
    }
    return { ok: true, signedTransactionInfo, environment: String(environment || "Sandbox") };
  } catch {
    return { ok: false, error: "apple_network_error", errorClass: "apple_network_error" };
  }
}

export function appleHealthPublic(probe) {
  return {
    appleConfigured: Boolean(probe?.appleConfigured),
    appleApiAuth: probe?.appleApiAuth === "pass" ? "pass" : "fail",
    environment: probe?.environment || "unconfigured",
    ...(probe?.appleApiAuth === "pass"
      ? {}
      : { errorClass: probe?.errorClass || "unknown" }),
  };
}
