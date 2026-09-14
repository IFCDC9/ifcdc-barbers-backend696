/**
 * Verify App Store signed JWS (transactions + ASSN v2) via x5c + Apple root CAs.
 * Never logs full JWS. Tests may mock HTTP; cryptographic checks stay on.
 */

import { X509Certificate } from "node:crypto";
import jwt from "jsonwebtoken";
import { APPLE_BUNDLE_ID, planFromAppleProductId } from "./monetizationCatalog.js";
import { loadAppleRootCertificates } from "./appleRootCertificates.js";

function decodeJwsHeaderUnsafe(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function normalizeAppleEnvironment(environment) {
  const e = String(environment || "").trim();
  if (!e) return null;
  if (e.toLowerCase() === "sandbox" || e.toLowerCase() === "xcode") return "sandbox";
  if (e.toLowerCase() === "production") return "production";
  return e.toLowerCase();
}

function certNotExpired(cert, nowMs) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return from <= nowMs && nowMs <= to;
}

/**
 * Apple StoreKit JWS uses x5c of length 3: leaf, intermediate, root (root must match Apple PKI).
 */
export function verifyAppleX5cChain(x5c, { now = Date.now(), roots = loadAppleRootCertificates() } = {}) {
  if (!Array.isArray(x5c) || x5c.length !== 3) {
    return { ok: false, error: "invalid_certificate_chain" };
  }
  let leaf;
  let intermediate;
  let embeddedRoot;
  try {
    leaf = new X509Certificate(Buffer.from(x5c[0], "base64"));
    intermediate = new X509Certificate(Buffer.from(x5c[1], "base64"));
    embeddedRoot = new X509Certificate(Buffer.from(x5c[2], "base64"));
  } catch {
    return { ok: false, error: "invalid_certificate" };
  }
  if (!certNotExpired(leaf, now) || !certNotExpired(intermediate, now) || !certNotExpired(embeddedRoot, now)) {
    return { ok: false, error: "certificate_expired" };
  }
  try {
    if (!leaf.verify(intermediate.publicKey)) {
      return { ok: false, error: "invalid_certificate_chain" };
    }
  } catch {
    return { ok: false, error: "invalid_certificate_chain" };
  }
  const trustedRoots = roots.map((buf) => new X509Certificate(buf));
  const embeddedFp = String(embeddedRoot.fingerprint256 || "").toLowerCase();
  const trusted = trustedRoots.find((r) => String(r.fingerprint256 || "").toLowerCase() === embeddedFp);
  if (!trusted) {
    return { ok: false, error: "untrusted_root" };
  }
  try {
    if (!intermediate.verify(trusted.publicKey)) {
      return { ok: false, error: "invalid_certificate_chain" };
    }
  } catch {
    return { ok: false, error: "invalid_certificate_chain" };
  }
  return { ok: true, publicKey: leaf.publicKey };
}

export function verifyStoreKitJws(jws) {
  const token = String(jws || "").trim();
  if (!token || token.split(".").length !== 3) {
    return { ok: false, error: "invalid_jws" };
  }
  const header = decodeJwsHeaderUnsafe(token);
  if (!header || header.alg !== "ES256") {
    return { ok: false, error: "invalid_jws" };
  }
  const chain = verifyAppleX5cChain(header.x5c);
  if (!chain.ok) return chain;
  try {
    const pem = chain.publicKey.export({ type: "spki", format: "pem" });
    const payload = jwt.verify(token, pem, { algorithms: ["ES256"] });
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "invalid_jws" };
    }
    return { ok: true, payload, header };
  } catch {
    return { ok: false, error: "invalid_jws" };
  }
}

export function assertAppleTransactionClaims(txn) {
  if (!txn || typeof txn !== "object") {
    return { ok: false, error: "invalid_transaction" };
  }
  const bundleId = String(txn.bundleId || "").trim();
  if (!bundleId) return { ok: false, error: "missing_bundle_id" };
  if (bundleId !== APPLE_BUNDLE_ID) return { ok: false, error: "wrong_bundle" };

  const productId = String(txn.productId || "").trim();
  if (!productId) return { ok: false, error: "missing_product_id" };
  if (!planFromAppleProductId(productId)) return { ok: false, error: "unknown_apple_product" };

  const originalTransactionId = String(txn.originalTransactionId || "").trim();
  if (!originalTransactionId) return { ok: false, error: "missing_original_transaction_id" };

  const environment = normalizeAppleEnvironment(txn.environment);
  if (!environment) return { ok: false, error: "missing_environment" };

  const purchaseDate = txn.purchaseDate != null ? Number(txn.purchaseDate) : null;
  const expiresDate = txn.expiresDate != null ? Number(txn.expiresDate) : null;
  const signedDate = txn.signedDate != null ? Number(txn.signedDate) : null;
  const revoked = txn.revocationDate != null && Number(txn.revocationDate) > 0;

  return {
    ok: true,
    txn: {
      ...txn,
      bundleId,
      productId,
      originalTransactionId,
      environment,
      purchaseDate,
      expiresDate,
      signedDate,
      revoked,
    },
  };
}

export function subscriptionStatusFromAppleTxn(txn, now = Date.now()) {
  if (txn?.revocationDate) return "expired";
  const expires = txn?.expiresDate != null ? Number(txn.expiresDate) : NaN;
  if (Number.isFinite(expires) && expires < now) return "expired";
  const appleStatus = txn?.status != null ? Number(txn.status) : null;
  if (appleStatus === 2 || appleStatus === 4) return "expired";
  if (appleStatus === 3) return "billing_retry";
  if (appleStatus === 5) return "grace";
  return "active";
}

export function verifySignedTransactionJws(jws) {
  const crypto = verifyStoreKitJws(jws);
  if (!crypto.ok) return crypto;
  return assertAppleTransactionClaims(crypto.payload);
}

export function verifySignedNotificationJws(signedPayload) {
  const outer = verifyStoreKitJws(signedPayload);
  if (!outer.ok) return outer;
  const body = outer.payload;
  const data = body?.data || {};
  const dataBundle = String(data.bundleId || body.bundleId || "").trim();
  if (dataBundle && dataBundle !== APPLE_BUNDLE_ID) {
    return { ok: false, error: "wrong_bundle" };
  }
  let txn = null;
  if (data.signedTransactionInfo) {
    const inner = verifySignedTransactionJws(data.signedTransactionInfo);
    if (!inner.ok) return inner;
    txn = inner.txn;
  }
  let renewal = null;
  if (data.signedRenewalInfo) {
    const renew = verifyStoreKitJws(data.signedRenewalInfo);
    if (!renew.ok) return { ok: false, error: "invalid_renewal_jws" };
    renewal = renew.payload;
  }
  return {
    ok: true,
    payload: body,
    txn,
    renewal,
  };
}
