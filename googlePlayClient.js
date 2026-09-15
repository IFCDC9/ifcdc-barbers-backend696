/**
 * Google Play Developer API verifier.
 * Uses GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (preferred) or GOOGLE_PLAY_ACCESS_TOKEN.
 * Never logs tokens, JSON keys, or purchase tokens.
 */

import jwt from "jsonwebtoken";
import { GOOGLE_PACKAGE_NAME } from "./monetizationCatalog.js";

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3";

export function googlePlayCredentialsConfigured() {
  return Boolean(
    String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim() ||
      String(process.env.GOOGLE_PLAY_ACCESS_TOKEN || "").trim(),
  );
}

function parseServiceAccount() {
  const raw = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return { ok: false, errorClass: "not_configured" };
  try {
    const parsed = JSON.parse(raw);
    const email = String(parsed?.client_email || "").trim();
    const key = String(parsed?.private_key || "").trim();
    if (!email || !key) return { ok: false, errorClass: "google_service_account_incomplete" };
    return { ok: true, clientEmail: email, privateKey: key.replace(/\\n/g, "\n") };
  } catch {
    return { ok: false, errorClass: "google_service_account_json_invalid" };
  }
}

export function classifyPlayHttpStatus(status) {
  const n = Number(status);
  if (n === 401) return "unauthorized";
  if (n === 403) return "forbidden";
  if (n === 404) return "not_found";
  if (n === 429) return "rate_limited";
  if (n >= 500) return "play_unavailable";
  if (n >= 400) return `http_${n}`;
  return "ok";
}

async function parseJsonSafe(res) {
  try {
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function getGooglePlayAccessToken({ fetchImpl = globalThis.fetch } = {}) {
  const envToken = String(process.env.GOOGLE_PLAY_ACCESS_TOKEN || "").trim();
  if (envToken) return { ok: true, source: "env" };
  const sa = parseServiceAccount();
  if (!sa.ok) return { ok: false, errorClass: sa.errorClass };
  const now = Math.floor(Date.now() / 1000);
  let assertion;
  try {
    assertion = jwt.sign(
      {
        iss: sa.clientEmail,
        scope: ANDROID_PUBLISHER_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      },
      sa.privateKey,
      { algorithm: "RS256" },
    );
  } catch {
    return { ok: false, errorClass: "google_jwt_sign_failed" };
  }
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const body = await parseJsonSafe(res);
    if (!res.ok || !body.access_token) {
      return { ok: false, errorClass: classifyPlayHttpStatus(res.status) };
    }
    return { ok: true, source: "service_account", accessToken: String(body.access_token) };
  } catch {
    return { ok: false, errorClass: "google_network_error" };
  }
}

function bearerFromTokenResult(tokenResult) {
  if (!tokenResult?.ok) return null;
  if (tokenResult.accessToken) return tokenResult.accessToken;
  return String(process.env.GOOGLE_PLAY_ACCESS_TOKEN || "").trim() || null;
}

export function googleEnvironmentFromPurchase(purchase) {
  if (!purchase || typeof purchase !== "object") return "production";
  if (purchase.testPurchase) return "sandbox";
  if (purchase.purchaseType === 0 || purchase.purchaseType === "0") return "sandbox";
  return "production";
}

export function mapSubscriptionV2ToPurchase(body, extras = {}) {
  const line =
    (body?.lineItems || []).find((l) => !extras.productId || l.productId === extras.productId) ||
    body?.lineItems?.[0] ||
    {};
  const state = String(body?.subscriptionState || "").toUpperCase();
  let subscriptionState = 1;
  if (state.includes("EXPIRED") || state.includes("REVOKED")) subscriptionState = 6;
  else if (state.includes("IN_GRACE")) subscriptionState = 3;
  else if (state.includes("ON_HOLD") || state.includes("PAUSED")) subscriptionState = 5;
  else if (state.includes("CANCELED")) subscriptionState = 2;
  const expiry = line.expiryTime ? Date.parse(line.expiryTime) : Number(body?.expiryTimeMillis) || null;
  const start = body?.startTime ? Date.parse(body.startTime) : Number(body?.startTimeMillis) || null;
  return {
    productId: line.productId || extras.productId || null,
    orderId: body?.latestOrderId || body?.orderId || null,
    purchaseToken: extras.purchaseToken || null,
    expiryTimeMillis: Number.isFinite(expiry) ? expiry : null,
    startTimeMillis: Number.isFinite(start) ? start : null,
    subscriptionState,
    autoRenewing: line.autoRenewingPlan?.autoRenewEnabled !== false,
    testPurchase: body?.testPurchase || null,
    purchaseType: body?.testPurchase ? 0 : body?.purchaseType,
  };
}

async function playGet(fetchImpl, token, path) {
  const ctrl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  const res = await fetchImpl(`${PLAY_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: ctrl,
  });
  const body = await parseJsonSafe(res);
  return { res, body };
}

export async function verifyGoogleSubscriptionPurchase({
  productId,
  purchaseToken,
  packageName,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!googlePlayCredentialsConfigured()) {
    return { ok: false, error: "google_credentials_not_configured", errorClass: "not_configured" };
  }
  const tokenStr = String(purchaseToken || "").trim();
  const sku = String(productId || "").trim();
  const pkg = String(packageName || GOOGLE_PACKAGE_NAME).trim() || GOOGLE_PACKAGE_NAME;
  if (!tokenStr) return { ok: false, error: "missing_purchase_token", errorClass: "missing_purchase_token" };
  if (pkg !== GOOGLE_PACKAGE_NAME) return { ok: false, error: "package_mismatch", errorClass: "package_mismatch" };
  const tokenResult = await getGooglePlayAccessToken({ fetchImpl });
  const bearer = bearerFromTokenResult(tokenResult);
  if (!tokenResult.ok || !bearer) {
    return { ok: false, error: "google_credentials_not_configured", errorClass: tokenResult.errorClass || "not_configured" };
  }
  const encodedToken = encodeURIComponent(tokenStr);
  try {
    const v2 = await playGet(
      fetchImpl,
      bearer,
      `/applications/${encodeURIComponent(pkg)}/purchases/subscriptionsv2/tokens/${encodedToken}`,
    );
    if (v2.res.ok) {
      const purchase = mapSubscriptionV2ToPurchase(v2.body, { productId: sku, purchaseToken: tokenStr });
      return { ok: true, purchase, environment: googleEnvironmentFromPurchase(purchase) };
    }
    if (sku && (v2.res.status === 404 || v2.res.status === 400)) {
      const v1 = await playGet(
        fetchImpl,
        bearer,
        `/applications/${encodeURIComponent(pkg)}/purchases/subscriptions/${encodeURIComponent(sku)}/tokens/${encodedToken}`,
      );
      if (v1.res.ok) {
        return {
          ok: true,
          purchase: { ...v1.body, productId: sku, purchaseToken: tokenStr },
          environment: googleEnvironmentFromPurchase(v1.body),
        };
      }
      return {
        ok: false,
        error: "google_verify_failed",
        errorClass: classifyPlayHttpStatus(v1.res.status),
      };
    }
    return {
      ok: false,
      error: "google_verify_failed",
      errorClass: classifyPlayHttpStatus(v2.res.status),
    };
  } catch {
    return { ok: false, error: "google_network_error", errorClass: "google_network_error" };
  }
}

export async function verifyGoogleOneTimePurchase({
  productId,
  purchaseToken,
  packageName,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!googlePlayCredentialsConfigured()) {
    return { ok: false, error: "google_credentials_not_configured", errorClass: "not_configured" };
  }
  const tokenStr = String(purchaseToken || "").trim();
  const sku = String(productId || "").trim();
  const pkg = String(packageName || GOOGLE_PACKAGE_NAME).trim() || GOOGLE_PACKAGE_NAME;
  if (!tokenStr) return { ok: false, error: "missing_purchase_token", errorClass: "missing_purchase_token" };
  if (!sku) return { ok: false, error: "missing_product_id", errorClass: "missing_product_id" };
  if (pkg !== GOOGLE_PACKAGE_NAME) return { ok: false, error: "package_mismatch", errorClass: "package_mismatch" };
  const tokenResult = await getGooglePlayAccessToken({ fetchImpl });
  const bearer = bearerFromTokenResult(tokenResult);
  if (!tokenResult.ok || !bearer) {
    return { ok: false, error: "google_credentials_not_configured", errorClass: tokenResult.errorClass || "not_configured" };
  }
  try {
    const got = await playGet(
      fetchImpl,
      bearer,
      `/applications/${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(tokenStr)}`,
    );
    if (!got.res.ok) {
      return { ok: false, error: "google_verify_failed", errorClass: classifyPlayHttpStatus(got.res.status) };
    }
    const purchase = { ...got.body, productId: sku, purchaseToken: tokenStr };
    return { ok: true, purchase, environment: googleEnvironmentFromPurchase(purchase) };
  } catch {
    return { ok: false, error: "google_network_error", errorClass: "google_network_error" };
  }
}
