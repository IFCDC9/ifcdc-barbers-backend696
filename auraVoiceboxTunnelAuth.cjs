/**
 * Shared-secret + HMAC auth for the Aura Voicebox tunnel proxy.
 * Voicebox admin stays on 127.0.0.1. Render never talks to it unauthenticated.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HEADER_TS = "x-ifcdc-timestamp";
const HEADER_NONCE = "x-ifcdc-nonce";
const HEADER_SIG = "x-ifcdc-signature";
const HEADER_SECRET = "x-voicebox-tunnel-secret";
const MAX_SKEW_MS = 90_000;
const NONCE_TTL_MS = 120_000;
const NONCE_CAP = 4000;

const replaySeen = new Map();

function envFlagOn(name) {
  const v = String(process.env[name] || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function defaultSecretFile() {
  return path.join(__dirname, "data", "aura-voicebox-tunnel.secret");
}

function readSecretFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return String(raw || "").trim();
  } catch {
    return "";
  }
}

function voiceboxTunnelSecret() {
  const env = String(process.env.VOICEBOX_TUNNEL_SECRET || "").trim();
  if (env) return env;
  const file = String(process.env.VOICEBOX_TUNNEL_SECRET_FILE || "").trim() || defaultSecretFile();
  return readSecretFile(file);
}

function isLoopbackBase(url) {
  return /127\.0\.0\.1|localhost/i.test(String(url || ""));
}

function voiceboxUsesTunnelAuth(baseUrl) {
  const secret = voiceboxTunnelSecret();
  if (!secret) return false;
  if (String(process.env.VOICEBOX_TUNNEL_AUTH || "").trim() === "0") return false;
  if (envFlagOn("VOICEBOX_TUNNEL_AUTH")) return true;
  const base = String(baseUrl || process.env.VOICEBOX_BASE_URL || "");
  if (/^https:\/\//i.test(base)) return true;
  if (base && !isLoopbackBase(base)) return true;
  return false;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf || Buffer.alloc(0)).digest("hex");
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left.length ? left : Buffer.from("x"), Buffer.from("y"));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function canonicalPath(p) {
  const raw = String(p || "/");
  if (!raw.startsWith("/")) return `/${raw}`;
  return raw;
}

function canonicalString({ timestamp, nonce, method, path: reqPath, bodySha256 }) {
  return `${timestamp}.${nonce}.${String(method || "GET").toUpperCase()}.${canonicalPath(reqPath)}.${bodySha256}`;
}

function bodyToBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function signVoiceboxTunnelRequest({ secret, method, path: reqPath, body }) {
  const key = String(secret || voiceboxTunnelSecret());
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyBuf = bodyToBuffer(body);
  const bodySha256 = sha256Hex(bodyBuf);
  const canonical = canonicalString({ timestamp, nonce, method, path: reqPath, bodySha256 });
  const signature = crypto.createHmac("sha256", key).update(canonical).digest("hex");
  return {
    [HEADER_TS]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIG]: signature,
  };
}

function pruneReplay(now) {
  if (replaySeen.size < NONCE_CAP / 2) {
    for (const [nonce, at] of replaySeen) {
      if (now - at > NONCE_TTL_MS) replaySeen.delete(nonce);
    }
    return;
  }
  for (const [nonce, at] of replaySeen) {
    if (now - at > NONCE_TTL_MS) replaySeen.delete(nonce);
  }
  while (replaySeen.size > NONCE_CAP) {
    const first = replaySeen.keys().next().value;
    if (first === undefined) break;
    replaySeen.delete(first);
  }
}

function extractBearer(headers) {
  const h = headers || {};
  const raw = String(h.authorization || h.Authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function headerValue(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  if (headers[name] != null) return String(headers[name]).trim();
  if (headers[want] != null) return String(headers[want]).trim();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return String(v || "").trim();
  }
  return "";
}

function verifyVoiceboxTunnelRequest({ secret, method, path: reqPath, body, headers }) {
  const key = String(secret || voiceboxTunnelSecret());
  if (!key) return { ok: false, reason: "secret_missing" };
  const timestamp = headerValue(headers, HEADER_TS);
  const nonce = headerValue(headers, HEADER_NONCE);
  const signature = headerValue(headers, HEADER_SIG);
  const shared = headerValue(headers, HEADER_SECRET) || extractBearer(headers);
  const now = Date.now();
  const ts = Number(timestamp);
  if (!timestamp || !Number.isFinite(ts)) return { ok: false, reason: "timestamp_missing" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "timestamp_skew" };
  if (!nonce || nonce.length < 16) return { ok: false, reason: "nonce_missing" };
  pruneReplay(now);
  if (replaySeen.has(nonce)) return { ok: false, reason: "replay" };
  const bodySha256 = sha256Hex(bodyToBuffer(body));

  if (signature) {
    const canonical = canonicalString({ timestamp, nonce, method, path: reqPath, bodySha256 });
    const expected = crypto.createHmac("sha256", key).update(canonical).digest("hex");
    if (!timingSafeEqualString(signature, expected)) return { ok: false, reason: "bad_signature" };
    replaySeen.set(nonce, now);
    return { ok: true, mode: "hmac" };
  }

  if (shared && timingSafeEqualString(shared, key)) {
    replaySeen.set(nonce, now);
    return { ok: true, mode: "shared_secret" };
  }
  return { ok: false, reason: "unauthorized" };
}

function classifyVoiceboxFailure(err, extra = {}) {
  const status = Number(err?.status || extra.status || 0);
  const msg = String(err?.message || extra.message || err || "");
  if (status === 401 || status === 403) return "auth_fail";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "tunnel_down";
  if (/auth_fail|unauthorized|bad_signature|timestamp_/i.test(msg)) return "auth_fail";
  if (/replay/i.test(msg)) return "auth_fail";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET/i.test(msg)) return "tunnel_down";
  if (/1033|cfargotunnel|cloudflare|tunnel/i.test(msg)) return "tunnel_down";
  if (/abort|timeout/i.test(msg)) return "timeout";
  return "error";
}

function sanitizeLog(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/x-voicebox-tunnel-secret[:\s=]+\S+/gi, "x-voicebox-tunnel-secret=[redacted]")
    .replace(/x-ifcdc-signature[:\s=]+\S+/gi, "x-ifcdc-signature=[redacted]")
    .replace(/VOICEBOX_TUNNEL_SECRET[:\s=]+\S+/gi, "VOICEBOX_TUNNEL_SECRET=[redacted]")
    .slice(0, 180);
}

function resetTunnelAuthForTests() {
  replaySeen.clear();
}

module.exports = {
  HEADER_TS,
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_SECRET,
  MAX_SKEW_MS,
  voiceboxTunnelSecret,
  voiceboxUsesTunnelAuth,
  isLoopbackBase,
  signVoiceboxTunnelRequest,
  verifyVoiceboxTunnelRequest,
  classifyVoiceboxFailure,
  sanitizeLog,
  sha256Hex,
  canonicalPath,
  resetTunnelAuthForTests,
  defaultSecretFile,
};
