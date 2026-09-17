/**
 * Production-path Voicebox checks: HMAC from https client, founder allowlist,
 * diag auth. Does not enable VOICEBOX_PRIMARY.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isVoiceboxPrimary,
  shouldUseVoiceboxForCall,
  isVoiceboxTestCaller,
  normalizeE164,
  maskPhoneLast4,
} = require("../auraVoiceboxFlags.cjs");
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const {
  tryVoiceboxPlayUrl,
  setVoiceboxClientForTests,
  resetVoiceboxBridgeForTests,
} = require("../auraVoiceboxBridge.cjs");
const { createAuraVoiceboxRouter } = require("../auraVoiceboxRoutes.cjs");
const { signVoiceboxTunnelRequest } = require("../auraVoiceboxTunnelAuth.cjs");
const { mergeBookingInfo, snapshotLedger, resetAllCallRuntime } = require("../auraVoiceCallRuntime.cjs");

const SECRET = "test-voicebox-tunnel-secret-32bytes-min";

function tinyWav() {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

function mockClient() {
  const wav = tinyWav();
  return {
    health: async () => ({ status: "healthy", model_loaded: true, online: true }),
    modelsStatus: async () => ({ models: [{ model_name: "kokoro", downloaded: true, loaded: true }] }),
    listProfiles: async () => [
      {
        id: "p-aura",
        name: "AURA — FOUNDER APPROVED V1",
        voice_type: "preset",
        preset_engine: "kokoro",
        preset_voice_id: "af_heart",
        default_engine: "kokoro",
      },
    ],
    createProfile: async (body) => ({ id: "p-aura", ...body }),
    updateProfile: async (id, body) => ({
      id,
      name: "AURA — FOUNDER APPROVED V1",
      voice_type: "preset",
      preset_engine: "kokoro",
      preset_voice_id: "af_heart",
      default_engine: "kokoro",
      ...body,
    }),
    generateStreamMeta: async () => ({ buffer: wav, contentType: "audio/wav", firstByteMs: 12, totalMs: 20 }),
    generateStream: async () => ({ buffer: wav, contentType: "audio/wav" }),
    generate: async () => ({ id: "gen-1", status: "completed" }),
    getAudio: async () => ({ buffer: wav, contentType: "audio/wav" }),
  };
}

test.beforeEach(() => {
  resetVoiceboxBridgeForTests();
  resetAllCallRuntime();
  delete process.env.VOICEBOX_PRIMARY;
  delete process.env.AURA_VOICEBOX_TEST_FROM;
  delete process.env.AURA_FOUNDER_PHONE;
});

test("VOICEBOX_PRIMARY stays off; unmatched caller is Polly", async () => {
  assert.equal(isVoiceboxPrimary(), false);
  assert.equal(shouldUseVoiceboxForCall({ from: "+15551212000" }), false);
  mergeBookingInfo("CA-allow", { service: "fade" });
  const play = await tryVoiceboxPlayUrl({
    text: "Hi, this is Aura.",
    language: "en",
    conversationId: "CA-allow",
    from: "+15551212000",
  });
  assert.equal(play.used, false);
  assert.equal(play.reason, "primary_off");
  assert.equal(snapshotLedger("CA-allow").booking.service, "fade");
});

test("allowlisted From hears Sample A while global primary stays 0", async () => {
  process.env.AURA_VOICEBOX_TEST_FROM = "+15551212999";
  process.env.PUBLIC_API_URL = "https://ifcdc-barbers-backend696.onrender.com";
  assert.equal(isVoiceboxPrimary(), false);
  assert.equal(isVoiceboxTestCaller("+15551212999"), true);
  assert.equal(shouldUseVoiceboxForCall({ from: "+15551212999" }), true);
  assert.equal(shouldUseVoiceboxForCall({ from: "+15550001111" }), false);
  setVoiceboxClientForTests(mockClient());
  const play = await tryVoiceboxPlayUrl({
    text: "Hi, this is Aura.",
    language: "en",
    conversationId: "CA-founder",
    from: "+15551212999",
  });
  assert.equal(play.used, true);
  assert.match(String(play.url), /\/api\/aura\/voicebox\/audio\//);
  assert.equal(isVoiceboxPrimary(), false);
});

test("maskPhoneLast4 never prints full number", () => {
  assert.equal(normalizeE164("5551212999"), "+15551212999");
  const masked = maskPhoneLast4("+15551212999");
  assert.match(masked, /2999$/);
  assert.doesNotMatch(masked, /5551212/);
});

test("https Voicebox client sends HMAC headers (production path)", async () => {
  const prev = {
    base: process.env.VOICEBOX_BASE_URL,
    secret: process.env.VOICEBOX_TUNNEL_SECRET,
    auth: process.env.VOICEBOX_TUNNEL_AUTH,
  };
  process.env.VOICEBOX_BASE_URL = "https://aura-voice.ifcdcbarbersapp.com";
  process.env.VOICEBOX_TUNNEL_SECRET = SECRET;
  process.env.VOICEBOX_TUNNEL_AUTH = "1";
  const captured = [];
  try {
    const client = createVoiceboxClient({
      fetch: async (url, opts) => {
        captured.push({ url: String(url), headers: opts.headers, method: opts.method });
        return new Response(JSON.stringify({ status: "healthy", online: true, model_loaded: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.health(2000);
    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /aura-voice\.ifcdcbarbersapp\.com\/health/);
    const h = captured[0].headers;
    assert.ok(h["x-ifcdc-timestamp"] || h["X-IFCDC-Timestamp"]);
    assert.ok(h["x-ifcdc-nonce"] || h["X-IFCDC-Nonce"]);
    assert.ok(h["x-ifcdc-signature"] || h["X-IFCDC-Signature"]);
  } finally {
    if (prev.base === undefined) delete process.env.VOICEBOX_BASE_URL;
    else process.env.VOICEBOX_BASE_URL = prev.base;
    if (prev.secret === undefined) delete process.env.VOICEBOX_TUNNEL_SECRET;
    else process.env.VOICEBOX_TUNNEL_SECRET = prev.secret;
    if (prev.auth === undefined) delete process.env.VOICEBOX_TUNNEL_AUTH;
    else process.env.VOICEBOX_TUNNEL_AUTH = prev.auth;
  }
});

test("diag route rejects public generate; accepts HMAC", async () => {
  const prevSecret = process.env.VOICEBOX_TUNNEL_SECRET;
  process.env.VOICEBOX_TUNNEL_SECRET = SECRET;
  setVoiceboxClientForTests(mockClient());
  const app = express();
  app.use(express.json());
  app.use("/api/aura/voicebox", createAuraVoiceboxRouter({}));
  const server = http.createServer(app);
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/aura/voicebox/diag`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(denied.status, 401);

    const headers = signVoiceboxTunnelRequest({
      secret: SECRET,
      method: "POST",
      path: "/api/aura/voicebox/diag",
      body: "",
    });
    const ok = await fetch(`http://127.0.0.1:${port}/api/aura/voicebox/diag`, {
      method: "POST",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.primary, false);
    assert.equal(json.productionActivation, "OFF");
    assert.equal(json.generate.ok, true);
    assert.equal(json.generate.validAudio, true);
    assert.equal(json.generate.sample, "A");
    assert.equal(json.generate.voiceId, "af_heart");
    assert.ok(json.generate.audioBytes > 0);
  } finally {
    server.close();
    if (prevSecret === undefined) delete process.env.VOICEBOX_TUNNEL_SECRET;
    else process.env.VOICEBOX_TUNNEL_SECRET = prevSecret;
  }
});

test("optional live prod→tunnel check", async (t) => {
  if (String(process.env.AURA_PROD_TUNNEL_CHECK || "").trim() !== "1") {
    t.skip("set AURA_PROD_TUNNEL_CHECK=1 to hit production /api/aura/voicebox/health");
    return;
  }
  const res = await fetch("https://ifcdc-barbers-backend696.onrender.com/api/aura/voicebox/health", {
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  assert.equal(json?.ok, true);
  assert.equal(json?.online, true);
});
