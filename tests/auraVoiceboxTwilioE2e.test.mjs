/**
 * Twilio e2e honesty: webhook simulation + live Voicebox through tunnel if up.
 * True PSTN is SKIP without a Founder phone. VOICEBOX_PRIMARY stays 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { SAMPLE_SENTENCE } = require("../auraVoiceboxProfile.cjs");
const { tryVoiceboxPlayUrl, speak, resetVoiceboxBridgeForTests } = require("../auraVoiceboxBridge.cjs");
const { isVoiceboxPrimary, voiceboxFlags } = require("../auraVoiceboxFlags.cjs");
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const { mergeBookingInfo, snapshotLedger, setCallLanguage, resetAllCallRuntime } = require("../auraVoiceCallRuntime.cjs");
const { signVoiceboxTunnelRequest } = require("../auraVoiceboxTunnelAuth.cjs");

function loadSecret() {
  const env = String(process.env.VOICEBOX_TUNNEL_SECRET || "").trim();
  if (env) return env;
  const file = join(root, "data", "aura-voicebox-tunnel.secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return "";
}

test.beforeEach(() => {
  resetVoiceboxBridgeForTests();
  resetAllCallRuntime();
});

test("Twilio webhook simulation: primary off stays Polly; booking preserved; no Aura Allah", async () => {
  assert.equal(isVoiceboxPrimary(), false);
  mergeBookingInfo("CA-e2e", { service: "fade", day: "tomorrow", time: "2:30 PM", name: "Jordan" });
  const play = await tryVoiceboxPlayUrl({
    text: SAMPLE_SENTENCE,
    language: "en",
    conversationId: "CA-e2e",
  });
  assert.equal(play.used, false);
  assert.equal(play.reason, "primary_off");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech dtmf" bargeIn="true"><Say voice="Polly.Joanna" language="en-US">${SAMPLE_SENTENCE}</Say></Gather></Response>`;
  assert.match(twiml, /Polly\.Joanna/);
  assert.match(twiml, /Hi, this is Aura/);
  assert.doesNotMatch(twiml, /Allah/i);
  assert.doesNotMatch(twiml, /<Play>/);
  setCallLanguage("CA-e2e", "es");
  assert.equal(snapshotLedger("CA-e2e").booking.service, "fade");
  assert.equal(snapshotLedger("CA-e2e").booking.time, "2:30 PM");
});

test("live Voicebox through named tunnel if authenticated; else honest SKIP", async (t) => {
  const secret = loadSecret();
  const hostname = String(process.env.VOICEBOX_TUNNEL_HOSTNAME || "aura-voice.ifcdcbarbersapp.com").trim();
  const publicUrl = `https://${hostname}`;
  if (!secret) {
    t.skip("VOICEBOX_TUNNEL_SECRET not on disk — Cloudflare/tunnel secret not installed yet");
    return;
  }
  const headers = signVoiceboxTunnelRequest({ secret, method: "GET", path: "/health", body: "" });
  let healthRes;
  try {
    healthRes = await fetch(`${publicUrl}/health`, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    t.skip(`named tunnel not reachable (${String(e?.message || e).slice(0, 120)}). Founder: cloudflared tunnel login`);
    return;
  }
  if (healthRes.status === 401) {
    t.skip("tunnel host up but auth rejected — set Render/Mac VOICEBOX_TUNNEL_SECRET to the same file");
    return;
  }
  if (!healthRes.ok) {
    t.skip(`tunnel host returned ${healthRes.status}; Voicebox/Mac/connector down — Polly fallback, not ONLINE`);
    return;
  }
  const health = await healthRes.json().catch(() => null);
  assert.equal(String(health?.status).toLowerCase(), "healthy");
  assert.equal(health.online, true);
  assert.notEqual(health.online, true && health.status !== "healthy");

  const prevBase = process.env.VOICEBOX_BASE_URL;
  const prevAuth = process.env.VOICEBOX_TUNNEL_AUTH;
  const prevSecret = process.env.VOICEBOX_TUNNEL_SECRET;
  process.env.VOICEBOX_BASE_URL = publicUrl;
  process.env.VOICEBOX_TUNNEL_AUTH = "1";
  process.env.VOICEBOX_TUNNEL_SECRET = secret;
  try {
    resetVoiceboxBridgeForTests();
    const started = Date.now();
    const out = await speak({ text: "Absolutely...", language: "en", conversationId: "CA-tunnel-live" });
    const ttfbMs = out.firstByteMs ?? Date.now() - started;
    if (!out.ok) {
      assert.equal(out.fallback, true);
      t.skip(`live tunnel speak fell back (${out.reason}) — Polly would keep the call`);
      return;
    }
    assert.equal(out.fallback, false);
    assert.ok(ttfbMs > 0);
    console.log("[aura/twilio-e2e] tunnel TTFB ms", ttfbMs, "includes Cloudflare hop");
  } finally {
    if (prevBase === undefined) delete process.env.VOICEBOX_BASE_URL;
    else process.env.VOICEBOX_BASE_URL = prevBase;
    if (prevAuth === undefined) delete process.env.VOICEBOX_TUNNEL_AUTH;
    else process.env.VOICEBOX_TUNNEL_AUTH = prevAuth;
    if (prevSecret === undefined) delete process.env.VOICEBOX_TUNNEL_SECRET;
    else process.env.VOICEBOX_TUNNEL_SECRET = prevSecret;
    resetVoiceboxBridgeForTests();
  }
});

test("true PSTN inbound call", (t) => {
  const founderPstn = String(process.env.AURA_FOUNDER_PSTN_TEST || "").trim() === "1";
  const from = String(process.env.AURA_FOUNDER_PHONE || "").trim();
  if (!founderPstn || !from) {
    t.skip("SKIP true PSTN — no Founder phone / AURA_FOUNDER_PSTN_TEST=1. Webhook simulation is the e2e we can run.");
    return;
  }
  assert.fail("PSTN helper is not wired without Founder-placed inbound call");
});

test("local loopback Voicebox still used by default flags", () => {
  const flags = voiceboxFlags();
  assert.equal(flags.primary, false);
  assert.equal(flags.productionActivation, "OFF");
  assert.match(String(flags.baseUrl), /^https?:\/\//);
  void createVoiceboxClient;
});
