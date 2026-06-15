/**
 * Verify Sign in with Apple identity tokens (JWT from ASAuthorizationAppleIDCredential).
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

let cachedKeys = null;
let cachedAt = 0;
const CACHE_MS = 60 * 60 * 1000;

function getAppleAudiences() {
  const bundleId = String(process.env.APPLE_BUNDLE_ID || "com.ifcdc.barbers").trim();
  const serviceId = String(process.env.APPLE_SERVICE_ID || "").trim();
  return [bundleId, serviceId].filter(Boolean);
}

async function fetchAppleJwks() {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CACHE_MS) return cachedKeys;
  const res = await fetch(APPLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`apple_jwks_unreachable_${res.status}`);
  }
  const data = await res.json();
  cachedKeys = Array.isArray(data?.keys) ? data.keys : [];
  cachedAt = now;
  return cachedKeys;
}

async function resolveApplePublicKey(kid) {
  const keys = await fetchAppleJwks();
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("apple_key_not_found");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * @param {string} identityToken
 * @returns {Promise<{ sub: string, email?: string, email_verified?: boolean }>}
 */
export async function verifyAppleIdentityToken(identityToken) {
  const token = String(identityToken || "").trim();
  if (!token) throw new Error("apple_token_missing");

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error("apple_token_malformed");

  const publicKey = await resolveApplePublicKey(decoded.header.kid);
  const audiences = getAppleAudiences();
  /** @type {import("jsonwebtoken").JwtPayload} */
  const payload = jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: APPLE_ISSUER,
    audience: audiences.length === 1 ? audiences[0] : audiences,
  });

  const sub = String(payload.sub || "").trim();
  if (!sub) throw new Error("apple_payload_invalid");

  const email = payload.email ? String(payload.email).trim().toLowerCase() : "";
  const ev = payload.email_verified;
  const emailVerified =
    ev === true || ev === "true" || ev === "True" || ev === 1 || ev === "1";

  return { sub, email: email || undefined, email_verified: emailVerified };
}
