/**
 * App Store Server API client (JWT ES256). Never logs keys, JWS, or bearer tokens.
 *
 * Apple IAP PKCS#8 (.p8) loading — Render Secret File first:
 *   Secret Files filename: ifcdc-barbers-iap.p8
 *   Env: APPLE_IAP_PRIVATE_KEY_FILE=/etc/secrets/ifcdc-barbers-iap.p8
 *   APPLE_IAP_ISSUER_ID and APPLE_IAP_KEY_ID stay as env vars.
 * If APPLE_IAP_PRIVATE_KEY_FILE is set, never fall back to APPLE_IAP_PRIVATE_KEY.
 * Try the env path, /etc/secrets/ifcdc-barbers-iap.p8, and /etc/secrets/<basename>.
 * Fail with file_not_found or file_unreadable. Never log file body / PEM.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createPrivateKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { APPLE_BUNDLE_ID } from "./monetizationCatalog.js";

export const APPLE_STOREKIT_SANDBOX = "https://api.storekit-sandbox.apple.com";
export const APPLE_STOREKIT_PRODUCTION = "https://api.storekit.apple.com";

/** Render Secret File mount convention (set APPLE_IAP_PRIVATE_KEY_FILE to this). */
export const APPLE_IAP_DEFAULT_PRIVATE_KEY_FILE = "/etc/secrets/ifcdc-barbers-iap.p8";
export const APPLE_IAP_SECRET_FILE_NAME = "ifcdc-barbers-iap.p8";
export const APPLE_IAP_SECRETS_DIR = "/etc/secrets";

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const s = String(p || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeTriedNames(paths) {
  return uniquePaths(paths.map((p) => basename(String(p || ""))));
}

/**
 * Render may mount a Secret File at the exact FILE path or at /etc/secrets/<name>.
 * Names only are safe to report; never include file contents.
 */
export function appleIapKeyFileCandidates(fileEnv = process.env.APPLE_IAP_PRIVATE_KEY_FILE) {
  const trimmed = String(fileEnv || "").trim();
  const base = trimmed ? basename(trimmed) : APPLE_IAP_SECRET_FILE_NAME;
  return uniquePaths([
    trimmed,
    APPLE_IAP_DEFAULT_PRIVATE_KEY_FILE,
    `${APPLE_IAP_SECRETS_DIR}/${base}`,
    `${APPLE_IAP_SECRETS_DIR}/${APPLE_IAP_SECRET_FILE_NAME}`,
  ]);
}

function emptyFileLoad({ errorClass, exists, pathHint, triedNames }) {
  return {
    source: "file",
    raw: "",
    path: pathHint || null,
    keyFileEnvSet: true,
    keyFileExists: Boolean(exists),
    fileMissing: errorClass === "file_not_found",
    unreadable: errorClass === "file_unreadable",
    errorClass,
    triedNames,
  };
}

/**
 * Read PKCS#8 material. If APPLE_IAP_PRIVATE_KEY_FILE is set, only file candidates
 * are used — no silent APPLE_IAP_PRIVATE_KEY fallback. Reads the complete file
 * (binary → utf8) so PEM newlines are preserved. Never logs the body.
 */
export function loadAppleIapPrivateKey() {
  const fileEnv = String(process.env.APPLE_IAP_PRIVATE_KEY_FILE || "").trim();
  if (fileEnv) {
    const candidates = appleIapKeyFileCandidates(fileEnv);
    const triedNames = safeTriedNames(candidates);
    let unreadablePath = null;
    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      try {
        const buf = readFileSync(filePath);
        const raw = Buffer.from(buf).toString("utf8");
        return {
          source: "file",
          raw,
          path: filePath,
          keyFileEnvSet: true,
          keyFileExists: true,
          triedNames,
        };
      } catch {
        unreadablePath = filePath;
      }
    }
    if (unreadablePath) {
      return emptyFileLoad({
        errorClass: "file_unreadable",
        exists: true,
        pathHint: unreadablePath,
        triedNames,
      });
    }
    return emptyFileLoad({
      errorClass: "file_not_found",
      exists: false,
      pathHint: fileEnv,
      triedNames,
    });
  }
  const envRaw = process.env.APPLE_IAP_PRIVATE_KEY;
  if (envRaw != null && String(envRaw).trim()) {
    return { source: "env", raw: String(envRaw), path: null, keyFileEnvSet: false, keyFileExists: false };
  }
  return { source: "none", raw: "", path: null, keyFileEnvSet: false, keyFileExists: false };
}

export function appleCredentialsConfigured() {
  const loaded = loadAppleIapPrivateKey();
  return Boolean(
    String(process.env.APPLE_IAP_ISSUER_ID || "").trim() &&
      String(process.env.APPLE_IAP_KEY_ID || "").trim() &&
      String(loaded.raw || "").trim(),
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
  s = s.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\r\n/g, "\n").trim();
  if (!s) return "";
  const block = s.match(/-----BEGIN ([A-Z0-9 ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/);
  if (block) {
    const type = block[1];
    const body = block[2].replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
  }
  if (!s.includes("BEGIN")) {
    const body = s.replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) || [body];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return s;
}

function keySourceLabel(loaded) {
  if (loaded?.source === "file" || loaded?.source === "env") return loaded.source;
  return "none";
}

function keyFilePublicMeta(loaded) {
  const meta = {
    keyFileEnvSet: Boolean(loaded?.keyFileEnvSet),
    keyFileExists: Boolean(loaded?.keyFileExists),
  };
  if (loaded?.keyFileEnvSet && !loaded?.keyFileExists && Array.isArray(loaded?.triedNames) && loaded.triedNames.length) {
    meta.keyFileTriedNames = loaded.triedNames;
  }
  return meta;
}

/** Classify the IAP key without returning key material. PKCS#8 EC P-256 only. */
export function inspectAppleSigningKey(loadedInput = null) {
  const loaded = loadedInput || loadAppleIapPrivateKey();
  const keySource = keySourceLabel(loaded);
  const fileMeta = keyFilePublicMeta(loaded);
  if (loaded.errorClass === "file_not_found" || loaded.fileMissing) {
    return { ok: false, errorClass: "file_not_found", keySource: "file", keyParse: "fail", ...fileMeta };
  }
  if (loaded.errorClass === "file_unreadable" || loaded.unreadable) {
    return { ok: false, errorClass: "file_unreadable", keySource: "file", keyParse: "fail", ...fileMeta };
  }
  const signingKey = normalizeApplePrivateKey(loaded.raw);
  if (!signingKey) {
    return { ok: false, errorClass: "private_key_missing_after_normalize", keySource, keyParse: "fail", ...fileMeta };
  }
  try {
    const keyObj = createPrivateKey(signingKey);
    const keyType = String(keyObj.asymmetricKeyType || "unknown");
    const curve = keyObj.asymmetricKeyDetails?.namedCurve || null;
    if (keyType !== "ec") {
      return {
        ok: false,
        errorClass: `private_key_type_${keyType}_not_ec`,
        keyType,
        keySource,
        keyParse: "fail",
        ...fileMeta,
      };
    }
    if (curve && curve !== "prime256v1" && curve !== "P-256") {
      return { ok: false, errorClass: "private_key_curve_not_p256", keyType, curve, keySource, keyParse: "fail", ...fileMeta };
    }
    return { ok: true, keyType, curve: curve || "p256", keySource, keyParse: "pass", ...fileMeta };
  } catch {
    return { ok: false, errorClass: "private_key_unreadable", keySource, keyParse: "fail", ...fileMeta };
  }
}

export function appleApiBaseForEnvironment(environment) {
  const env = String(environment || "").toLowerCase();
  if (env === "production") return APPLE_STOREKIT_PRODUCTION;
  return APPLE_STOREKIT_SANDBOX;
}

/**
 * Lookup order: named environment first, then the other.
 * Unknown/missing: Production then Sandbox (Apple's Get Transaction Info guidance).
 */
export function appleApiBasesToTry(environment) {
  const env = String(environment || "").toLowerCase();
  const production = { environment: "Production", base: APPLE_STOREKIT_PRODUCTION };
  const sandbox = { environment: "Sandbox", base: APPLE_STOREKIT_SANDBOX };
  if (env === "production") return [production, sandbox];
  if (env === "sandbox" || env === "xcode") return [sandbox, production];
  return [production, sandbox];
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
  const loaded = loadAppleIapPrivateKey();
  const fileMeta = keyFilePublicMeta(loaded);
  if (loaded.errorClass === "file_not_found" || loaded.errorClass === "file_unreadable") {
    return {
      ok: false,
      errorClass: loaded.errorClass,
      keySource: "file",
      keyParse: "fail",
      ...fileMeta,
    };
  }
  if (!appleCredentialsConfigured()) {
    return { ok: false, errorClass: "not_configured", keySource: keySourceLabel(loaded), keyParse: "fail", ...fileMeta };
  }
  const issuerId = String(process.env.APPLE_IAP_ISSUER_ID || "").trim();
  const keyId = String(process.env.APPLE_IAP_KEY_ID || "").trim();
  const signingKey = normalizeApplePrivateKey(loaded.raw);
  if (!signingKey) {
    return { ok: false, errorClass: "private_key_invalid", keySource: keySourceLabel(loaded), keyParse: "fail" };
  }
  const shape = inspectAppleSigningKey(loaded);
  if (!shape.ok) {
    return { ok: false, errorClass: shape.errorClass, keySource: shape.keySource, keyParse: "fail" };
  }
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
    return { ok: true, token, keySource: shape.keySource, keyParse: "pass" };
  } catch (err) {
    return {
      ok: false,
      errorClass: classifyJwtSignError(err),
      keySource: shape.keySource,
      keyParse: "fail",
    };
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
  const loaded = loadAppleIapPrivateKey();
  const shape = inspectAppleSigningKey(loaded);
  const keyMeta = {
    keySource: keySourceLabel(loaded),
    keyParse: shape.ok ? "pass" : "fail",
    ...keyFilePublicMeta(loaded),
  };
  if (shape.errorClass === "file_not_found" || shape.errorClass === "file_unreadable") {
    return {
      appleConfigured: false,
      appleApiAuth: "fail",
      environment: "unconfigured",
      errorClass: shape.errorClass,
      ...keyMeta,
    };
  }
  if (!appleCredentialsConfigured()) {
    return {
      appleConfigured: false,
      appleApiAuth: "fail",
      environment: "unconfigured",
      errorClass: "not_configured",
      ...keyMeta,
    };
  }
  const signed = createAppStoreServerApiJwt();
  if (!signed.ok) {
    return {
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: signed.errorClass,
      ...keyMeta,
    };
  }
  const headers = {
    Authorization: `Bearer ${signed.token}`,
    Accept: "application/json",
  };
  let productionApiAuth = "unprobed";
  try {
    const prodUrl = `${APPLE_STOREKIT_PRODUCTION}/inApps/v1/notifications/test`;
    const prodRes = await appleFetch(fetchImpl, prodUrl, { method: "GET", headers });
    productionApiAuth = prodRes.status === 401 || prodRes.status === 403 ? "fail" : "pass";
  } catch {
    productionApiAuth = "fail";
  }
  const attach = (result) => ({
    ...result,
    productionApiAuth,
    sandboxApiAuth: result.appleApiAuth,
  });
  const sandboxUrl = `${APPLE_STOREKIT_SANDBOX}/inApps/v1/notifications/test`;
  try {
    const getRes = await appleFetch(fetchImpl, sandboxUrl, { method: "GET", headers });
    if (getRes.status === 401 || getRes.status === 403) {
      const body = await parseAppleJsonSafe(getRes);
      return attach({
        appleConfigured: true,
        appleApiAuth: "fail",
        environment: "Sandbox",
        errorClass: classifyAppleApiHttpStatus(getRes.status, body.errorCode),
        appleErrorCode: body.errorCode ?? null,
        ...keyMeta,
      });
    }
    if (getRes.status === 405 || getRes.status === 404) {
      const postRes = await appleFetch(fetchImpl, sandboxUrl, { method: "POST", headers });
      if (postRes.status === 401 || postRes.status === 403) {
        const body = await parseAppleJsonSafe(postRes);
        return attach({
          appleConfigured: true,
          appleApiAuth: "fail",
          environment: "Sandbox",
          errorClass: classifyAppleApiHttpStatus(postRes.status, body.errorCode),
          appleErrorCode: body.errorCode ?? null,
          ...keyMeta,
        });
      }
      if (postRes.ok || postRes.status === 202) {
        return attach({ appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox", ...keyMeta });
      }
      const body = await parseAppleJsonSafe(postRes);
      if (postRes.status === 401 || postRes.status === 403) {
        return attach({
          appleConfigured: true,
          appleApiAuth: "fail",
          environment: "Sandbox",
          errorClass: classifyAppleApiHttpStatus(postRes.status, body.errorCode),
          ...keyMeta,
        });
      }
      /* Authenticated but unexpected status — still proves JWT accepted if not 401/403 */
      if (postRes.status !== 401 && postRes.status !== 403) {
        return attach({ appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox", ...keyMeta });
      }
    }
    if (getRes.ok || getRes.status === 202) {
      return attach({ appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox", ...keyMeta });
    }
    if (getRes.status !== 401 && getRes.status !== 403) {
      return attach({ appleConfigured: true, appleApiAuth: "pass", environment: "Sandbox", ...keyMeta });
    }
    return attach({
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: classifyAppleApiHttpStatus(getRes.status),
      ...keyMeta,
    });
  } catch (err) {
    const msg = String(err?.name || err?.message || "network_error");
    return attach({
      appleConfigured: true,
      appleApiAuth: "fail",
      environment: "Sandbox",
      errorClass: msg === "TimeoutError" ? "apple_timeout" : "apple_network_error",
      ...keyMeta,
    });
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
  const tries = appleApiBasesToTry(environment);
  let lastFail = null;
  for (const tryEnv of tries) {
    const url = `${tryEnv.base}/inApps/v1/transactions/${encodeURIComponent(id)}`;
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
          environment: tryEnv.environment,
        };
      }
      if (res.status === 404) {
        lastFail = {
          ok: false,
          error: "apple_lookup_failed",
          errorClass: "not_found",
          environment: tryEnv.environment,
        };
        continue;
      }
      if (!res.ok) {
        lastFail = {
          ok: false,
          error: "apple_lookup_failed",
          errorClass: classifyAppleApiHttpStatus(res.status, body.errorCode),
          environment: tryEnv.environment,
        };
        continue;
      }
      const signedTransactionInfo = body.signedTransactionInfo;
      if (!signedTransactionInfo) {
        return { ok: false, error: "apple_lookup_missing_transaction", environment: tryEnv.environment };
      }
      return { ok: true, signedTransactionInfo, environment: tryEnv.environment };
    } catch {
      lastFail = { ok: false, error: "apple_network_error", errorClass: "apple_network_error", environment: tryEnv.environment };
    }
  }
  return lastFail || { ok: false, error: "apple_lookup_failed", errorClass: "not_found" };
}

export function appleHealthPublic(probe) {
  const keySource =
    probe?.keySource === "file" || probe?.keySource === "env" ? probe.keySource : "none";
  const keyParse = probe?.keyParse === "pass" ? "pass" : "fail";
  const out = {
    appleConfigured: Boolean(probe?.appleConfigured),
    appleApiAuth: probe?.appleApiAuth === "pass" ? "pass" : "fail",
    keyFileEnvSet: Boolean(probe?.keyFileEnvSet),
    keyFileExists: Boolean(probe?.keyFileExists),
    keySource,
    keyParse,
    environment: probe?.environment || "unconfigured",
  };
  if (probe?.productionApiAuth === "pass" || probe?.productionApiAuth === "fail") {
    out.productionApiAuth = probe.productionApiAuth;
  }
  if (probe?.sandboxApiAuth === "pass" || probe?.sandboxApiAuth === "fail") {
    out.sandboxApiAuth = probe.sandboxApiAuth;
  }
  if (probe?.appleApiAuth !== "pass") {
    out.errorClass = probe?.errorClass || "unknown";
  }
  if (Array.isArray(probe?.keyFileTriedNames) && probe.keyFileTriedNames.length) {
    out.keyFileTriedNames = uniquePaths(
      probe.keyFileTriedNames.map((n) => basename(String(n || ""))),
    ).slice(0, 8);
  }
  return out;
}
