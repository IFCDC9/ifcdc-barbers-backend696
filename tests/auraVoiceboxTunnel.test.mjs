/**
 * Secure Aura Voicebox tunnel proxy — hard PASS/FAIL.
 * Does not enable VOICEBOX_PRIMARY. Does not expose Voicebox admin.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  signVoiceboxTunnelRequest,
  verifyVoiceboxTunnelRequest,
  resetTunnelAuthForTests,
  classifyVoiceboxFailure,
} = require("../auraVoiceboxTunnelAuth.cjs");
const {
  matchRoute,
  createProxyHandler,
  sanitizeGenerateJson,
  filterProfiles,
  resetProxyRateLimitsForTests,
} = require("../auraVoiceboxTunnelProxy.cjs");
const { speak, setVoiceboxClientForTests, resetVoiceboxBridgeForTests } = require("../auraVoiceboxBridge.cjs");
const { isVoiceboxPrimary } = require("../auraVoiceboxFlags.cjs");
const { isMacVoiceOnline, writeVoiceRuntime, RUNTIME_PATH } = require("../auraVoiceboxTunnelStatus.cjs");
const { unlinkSync } = require("node:fs");

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

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function signedHeaders(method, path, body = "") {
  return signVoiceboxTunnelRequest({ secret: SECRET, method, path, body });
}

function request(port, { method = "GET", path = "/health", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, buf, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startMockVoicebox() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", model_loaded: true, backend_type: "pytorch", backend_variant: "cpu", gpu_available: false }));
      return;
    }
    if (url.pathname === "/health/filesystem") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, leaked: "/Users/secret" }));
      return;
    }
    if (url.pathname === "/docs" || url.pathname === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ leaked: true }));
      return;
    }
    if (url.pathname === "/models/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ model_name: "kokoro", downloaded: true, loaded: true, display_name: "Kokoro 82M" }] }));
      return;
    }
    if (url.pathname === "/profiles" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { id: "p-aura", name: "AURA — FOUNDER APPROVED V1", voice_type: "preset", preset_engine: "kokoro", preset_voice_id: "af_heart", default_engine: "kokoro", language: "en" },
          { id: "p-clone", name: "Founder clone", voice_type: "cloned", preset_engine: "qwen", preset_voice_id: "x" },
        ]),
      );
      return;
    }
    if (url.pathname === "/generate/stream") {
      const wav = tinyWav();
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      res.end(wav);
      return;
    }
    if (url.pathname === "/generate") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "gen-1", status: "completed" }));
      return;
    }
    res.writeHead(404).end("no");
  });
  return server;
}

async function startProxy(upstreamPort) {
  resetTunnelAuthForTests();
  resetProxyRateLimitsForTests();
  const handler = createProxyHandler({
    secret: SECRET,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    host: "127.0.0.1",
  });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("{}");
    });
  });
  const port = await listen(server);
  return { server, port };
}

test.beforeEach(() => {
  resetTunnelAuthForTests();
  resetProxyRateLimitsForTests();
  resetVoiceboxBridgeForTests();
});

test("tunnel auth HMAC roundtrip and replay reject", () => {
  const headers = signedHeaders("GET", "/health", "");
  const first = verifyVoiceboxTunnelRequest({ secret: SECRET, method: "GET", path: "/health", body: "", headers });
  assert.equal(first.ok, true);
  const replay = verifyVoiceboxTunnelRequest({ secret: SECRET, method: "GET", path: "/health", body: "", headers });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "replay");
});

test("allowlist health/speak only; deny admin/docs/filesystem", () => {
  assert.equal(matchRoute("GET", "/health"), "health");
  assert.equal(matchRoute("POST", "/generate/stream"), "speak");
  assert.equal(matchRoute("GET", "/docs"), null);
  assert.equal(matchRoute("GET", "/openapi.json"), null);
  assert.equal(matchRoute("GET", "/health/filesystem"), null);
  assert.equal(matchRoute("POST", "/models/load"), null);
  assert.equal(matchRoute("POST", "/profiles"), null);
  assert.equal(matchRoute("PUT", "/profiles/abc"), null);
  assert.equal(matchRoute("GET", "/../etc/passwd"), null);
  const filtered = sanitizeGenerateJson(JSON.stringify({ text: "Hi this is Aura", engine: "kokoro", audio_path: "/etc/passwd", cmd: "rm -rf /" }));
  assert.equal(filtered.text, "Hi this is Aura");
  assert.equal(filtered.audio_path, undefined);
  assert.equal(filtered.cmd, undefined);
  const profiles = filterProfiles([
    { id: "1", name: "AURA — FOUNDER APPROVED V1", voice_type: "preset" },
    { id: "2", name: "secret clone", voice_type: "cloned" },
  ]);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "AURA — FOUNDER APPROVED V1");
});

test("proxy 401 without auth; 404 admin; signed health sanitized", async () => {
  const up = startMockVoicebox();
  const upPort = await listen(up);
  const proxy = await startProxy(upPort);
  try {
    const denied = await request(proxy.port, { path: "/health" });
    assert.equal(denied.status, 401);
    assert.equal(denied.json?.ok, false);

    const docs = await request(proxy.port, {
      path: "/docs",
      headers: signedHeaders("GET", "/docs"),
    });
    assert.equal(docs.status, 404);

    const fsHealth = await request(proxy.port, {
      path: "/health/filesystem",
      headers: signedHeaders("GET", "/health/filesystem"),
    });
    assert.equal(fsHealth.status, 404);
    assert.doesNotMatch(JSON.stringify(fsHealth.json || {}), /\/Users\/secret/);

    const health = await request(proxy.port, {
      path: "/health",
      headers: signedHeaders("GET", "/health"),
    });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, "healthy");
    assert.equal(health.json.online, true);
    assert.equal(health.json.productionActivation, "OFF");
    assert.equal(health.json.voiceboxPrimary, 0);

    const profiles = await request(proxy.port, {
      path: "/profiles",
      headers: signedHeaders("GET", "/profiles"),
    });
    assert.equal(profiles.status, 200);
    assert.equal(profiles.json.length, 1);
    assert.equal(profiles.json[0].preset_voice_id, "af_heart");
    assert.equal(profiles.json.some((p) => p.voice_type === "cloned"), false);
  } finally {
    proxy.server.close();
    up.close();
  }
});

test("auth_fail and tunnel_down fall back to Polly path (no dropped call)", async () => {
  assert.equal(isVoiceboxPrimary(), false);
  assert.equal(classifyVoiceboxFailure({ status: 401 }), "auth_fail");
  assert.equal(classifyVoiceboxFailure({ status: 503 }), "tunnel_down");
  assert.equal(classifyVoiceboxFailure(new Error("ECONNREFUSED")), "tunnel_down");

  setVoiceboxClientForTests({
    health: async () => {
      const err = new Error("voicebox_401");
      err.status = 401;
      throw err;
    },
  });
  const auth = await speak({ text: "Hello", language: "en", conversationId: "auth-fail" });
  assert.equal(auth.ok, false);
  assert.equal(auth.fallback, true);
  assert.equal(auth.reason, "auth_fail");

  resetVoiceboxBridgeForTests();
  setVoiceboxClientForTests({
    health: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const down = await speak({ text: "Hello", language: "en", conversationId: "tunnel-down" });
  assert.equal(down.ok, false);
  assert.equal(down.fallback, true);
  assert.equal(down.reason, "tunnel_down");
});

test("runtime status is not ONLINE when Voicebox is down or heartbeat stale", () => {
  const down = writeVoiceRuntime({
    voicebox: { ok: false, status: "down" },
    proxy: { ok: true },
    macAsleep: false,
  });
  assert.equal(down.online, false);
  assert.equal(isMacVoiceOnline(down), false);
  const stale = { ...down, online: true, voicebox: { ok: true }, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(isMacVoiceOnline(stale), false);
  try {
    unlinkSync(RUNTIME_PATH);
  } catch {
    /* ignore */
  }
});

test("live Voicebox through local allowlisted proxy (TTFB includes proxy hop)", async (t) => {
  let live = null;
  try {
    const res = await fetch("http://127.0.0.1:17493/health", { signal: AbortSignal.timeout(1500) });
    live = await res.json();
  } catch {
    t.skip("Voicebox not listening on 127.0.0.1:17493");
    return;
  }
  if (String(live?.status).toLowerCase() !== "healthy") {
    t.skip("Voicebox /health is not healthy");
    return;
  }
  const handler = createProxyHandler({
    secret: SECRET,
    upstream: "http://127.0.0.1:17493",
    host: "127.0.0.1",
    timeoutMs: 25000,
  });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("{}");
    });
  });
  const port = await listen(server);
  try {
    const health = await request(port, { path: "/health", headers: signedHeaders("GET", "/health") });
    assert.equal(health.status, 200);
    assert.equal(health.json.online, true);
    const profiles = await request(port, { path: "/profiles", headers: signedHeaders("GET", "/profiles") });
    assert.equal(profiles.status, 200);
    const profile = Array.isArray(profiles.json) ? profiles.json[0] : null;
    assert.ok(profile?.id);
    const body = JSON.stringify({
      profile_id: profile.id,
      text: "Absolutely...",
      language: "en",
      engine: "kokoro",
      personality: false,
      normalize: true,
    });
    const t0 = Date.now();
    const gen = await request(port, {
      method: "POST",
      path: "/generate/stream",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...signedHeaders("POST", "/generate/stream", body),
      },
      body,
    });
    const ttfbMs = Date.now() - t0;
    assert.equal(gen.status, 200);
    assert.ok(gen.buf.length > 16);
    assert.equal(gen.buf.slice(0, 4).toString("ascii"), "RIFF");
    console.log("[aura/tunnel-test] local proxy TTFB ms", ttfbMs, "bytes", gen.buf.length);
  } finally {
    server.close();
  }
});

test("VOICEBOX_PRIMARY remains off", () => {
  assert.equal(isVoiceboxPrimary(), false);
});
