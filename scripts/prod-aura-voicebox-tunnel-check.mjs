#!/usr/bin/env node
/**
 * Production backend → Voicebox tunnel check.
 * Uses the SAME HMAC as production (Mac/Render shared secret). Never prints the secret.
 * Does not set VOICEBOX_PRIMARY.
 *
 *   node scripts/prod-aura-voicebox-tunnel-check.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { signVoiceboxTunnelRequest } = require("../auraVoiceboxTunnelAuth.cjs");
const { maskPhoneLast4 } = require("../auraVoiceboxFlags.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD = String(process.env.PUBLIC_API_URL || process.env.PROD_API_URL || "https://ifcdc-barbers-backend696.onrender.com")
  .trim()
  .replace(/\/$/, "");
const DIAG_PATH = "/api/aura/voicebox/diag";

function loadSecret() {
  const env = String(process.env.VOICEBOX_TUNNEL_SECRET || "").trim();
  if (env) return env;
  const mac = join(homedir(), "Library/Application Support/ifcdc-aura-voice/data/aura-voicebox-tunnel.secret");
  if (existsSync(mac)) return readFileSync(mac, "utf8").trim();
  const repo = join(ROOT, "data/aura-voicebox-tunnel.secret");
  if (existsSync(repo)) return readFileSync(repo, "utf8").trim();
  return "";
}

function sha8(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 8);
}

async function publicStatus() {
  const res = await fetch(`${PROD}/api/aura/voicebox/status`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json().catch(() => null);
  const vb = json?.voicebox || json || {};
  return {
    http: res.status,
    primary: json?.primary ?? vb.primary,
    status: vb.status,
    baseUrl: vb.baseUrl,
    reachable: vb.reachable,
    productionActivation: vb.productionActivation,
    tunnel: vb.tunnel || {},
    publicName: vb.publicName || vb.founderApproved?.publicName,
    voiceId: vb.founderApproved?.voiceId,
  };
}

async function main() {
  const secret = loadSecret();
  const testFrom = String(process.env.AURA_VOICEBOX_TEST_FROM || process.env.AURA_FOUNDER_PHONE || "").trim();
  const auraDial = String(process.env.AURA_PHONE_NUMBER || "+19895141064").trim();

  let status;
  try {
    status = await publicStatus();
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          prodHealth: "FAIL",
          prodGenerate: "FAIL",
          error: String(e?.message || e).slice(0, 180),
          prod: PROD,
        },
        null,
        2,
      ),
    );
    process.exit(2);
    return;
  }

  const report = {
    prod: PROD,
    publicName: status.publicName,
    voiceId: status.voiceId,
    voiceboxPrimary: status.primary === true ? 1 : 0,
    productionActivation: status.productionActivation,
    baseUrl: status.baseUrl,
    baseUrlSet: status.baseUrl === "https://aura-voice.ifcdcbarbersapp.com" ? "yes" : "no",
    secretConfigured: Boolean(status.tunnel?.secretConfigured),
    macSecretSha256_8: secret ? sha8(secret) : null,
    tunnelAuth: status.tunnel?.auth || null,
    loopback: status.tunnel?.loopback,
    hmacReadyOnStatus: status.tunnel?.auth === "hmac" && !status.tunnel?.loopback,
  };

  if (!secret) {
    console.log(
      JSON.stringify(
        {
          ...report,
          prodHealth: "FAIL",
          prodGenerate: "FAIL",
          reason: "local_secret_missing",
          liveCall: "blocked",
          note: "Need Mac tunnel secret to HMAC /api/aura/voicebox/diag",
        },
        null,
        2,
      ),
    );
    process.exit(2);
    return;
  }

  const headers = signVoiceboxTunnelRequest({ secret, method: "POST", path: DIAG_PATH, body: "" });
  const started = Date.now();
  let diagRes;
  try {
    diagRes = await fetch(`${PROD}${DIAG_PATH}`, {
      method: "POST",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          ...report,
          prodHealth: "FAIL",
          prodGenerate: "FAIL",
          error: String(e?.message || e).slice(0, 180),
          liveCall: "blocked",
        },
        null,
        2,
      ),
    );
    process.exit(2);
    return;
  }

  const diagMs = Date.now() - started;
  const diag = await diagRes.json().catch(() => null);
  const healthPass = Boolean(diag?.health?.ok);
  const genPass = Boolean(diag?.generate?.ok && diag?.generate?.validAudio);
  const hmacFail = diagRes.status === 401 || diagRes.status === 403;
  const liveCall =
    healthPass && genPass && report.voiceboxPrimary === 0
      ? testFrom
        ? "READY"
        : "blocked"
      : "blocked";

  const out = {
    ...report,
    diagHttp: diagRes.status,
    hmacAuth: hmacFail ? "FAIL" : diagRes.ok ? "PASS" : "FAIL",
    prodHealth: healthPass ? "PASS" : "FAIL",
    prodGenerate: genPass ? "PASS" : "FAIL",
    healthMs: diag?.health?.ms ?? null,
    ttfbMs: diag?.generate?.firstByteMs ?? null,
    generateTotalMs: diag?.generate?.totalMs ?? null,
    audioBytes: diag?.generate?.audioBytes ?? 0,
    validAudio: Boolean(diag?.generate?.validAudio),
    hmacReady: Boolean(diag?.hmacReady),
    playUrlReady: Boolean(diag?.playUrlReady),
    diagRoundtripMs: diagMs,
    liveCall,
    dialAura: maskPhoneLast4(auraDial) || "***1064",
    testFrom: testFrom ? maskPhoneLast4(testFrom) : "(unset — set AURA_VOICEBOX_TEST_FROM)",
    productionVoiceStillNotPrimary: report.voiceboxPrimary === 0,
    note:
      hmacFail
        ? "Production rejected HMAC. Tessa must paste the SAME Mac secret as VOICEBOX_TUNNEL_SECRET and set VOICEBOX_BASE_URL=https://aura-voice.ifcdcbarbersapp.com. Keep VOICEBOX_PRIMARY=0."
        : liveCall === "READY"
          ? "Founder: dial Aura Twilio line from the allowlisted handset only. Do not set VOICEBOX_PRIMARY=1."
          : "Live call blocked until prod HMAC health+generate pass and AURA_VOICEBOX_TEST_FROM is set.",
  };
  console.log(JSON.stringify(out, null, 2));
  if (!healthPass || !genPass || hmacFail) process.exit(2);
}

await main();
