#!/usr/bin/env node
/**
 * Founder Mac monitor: Voicebox + tunnel proxy + Pipecat + cloudflared.
 * Restarts launchd agents on drop. Never reports online if Voicebox is down.
 * Does not enable VOICEBOX_PRIMARY. Does not exec from the public proxy.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { writeVoiceRuntime, isMacVoiceOnline } = require("../auraVoiceboxTunnelStatus.cjs");
const { sanitizeLog } = require("../auraVoiceboxTunnelAuth.cjs");

const ROOT = path.join(__dirname, "..");
const INTERVAL_MS = Math.max(4000, Number(process.env.AURA_VOICE_MONITOR_MS || 8000));
const VOICEBOX_URL = process.env.VOICEBOX_UPSTREAM_URL || "http://127.0.0.1:17493";
const PROXY_URL = `http://127.0.0.1:${process.env.VOICEBOX_TUNNEL_PROXY_PORT || 17494}`;
const PIPECAT_URL = process.env.PIPECAT_SIDECAR_URL || "http://127.0.0.1:8766";
const VOICEBOX_APP = "/Applications/Voicebox.app";
const LABELS = {
  proxy: "com.ifcdc.aura.voicebox-proxy",
  pipecat: "com.ifcdc.aura.pipecat",
  cloudflared: "com.ifcdc.aura.cloudflared",
};

let lastVoiceboxOpen = 0;
let lastKick = {};

function execFileP(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: err ? String(err.message || err).slice(0, 160) : null,
      });
    });
  });
}

async function probe(url, timeoutMs = 1800) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && String(body?.status || "").toLowerCase() !== "unhealthy", status: res.status, body };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function processRunning(pattern) {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-f", pattern], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("close", (code) => resolve(code === 0 && Boolean(out.trim())));
    child.on("error", () => resolve(false));
  });
}

async function kickstart(label) {
  const now = Date.now();
  if (lastKick[label] && now - lastKick[label] < 20_000) return { skipped: true };
  lastKick[label] = now;
  const uid = process.getuid ? process.getuid() : 501;
  const r = await execFileP("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
  console.warn("[aura/voice-monitor] kickstart", label, r.ok ? "ok" : sanitizeLog(r.error || r.stderr));
  return r;
}

async function maybeOpenVoicebox() {
  const now = Date.now();
  if (now - lastVoiceboxOpen < 45_000) return;
  lastVoiceboxOpen = now;
  if (!fs.existsSync(VOICEBOX_APP)) return;
  await execFileP("open", ["-a", "Voicebox"]);
  console.warn("[aura/voice-monitor] asked Voicebox.app to open");
}

async function tick() {
  const voicebox = await probe(`${VOICEBOX_URL.replace(/\/$/, "")}/health`);
  const proxyLocal = await probe(`${PROXY_URL.replace(/\/$/, "")}/health`);
  const pipecat = await probe(`${PIPECAT_URL.replace(/\/$/, "")}/health`);
  const cloudflared = await processRunning("cloudflared.*ifcdc-aura-voicebox|cloudflared tunnel");
  const proxyProc = await processRunning("auraVoiceboxTunnelProxy");
  const pipecatProc = await processRunning("tools/pipecat/sidecar.py");

  if (!voicebox.ok) await maybeOpenVoicebox();
  if (!proxyProc) await kickstart(LABELS.proxy);
  if (!pipecatProc) await kickstart(LABELS.pipecat);
  if (!cloudflared) await kickstart(LABELS.cloudflared);

  const runtime = writeVoiceRuntime({
    voicebox: {
      ok: Boolean(voicebox.ok && String(voicebox.body?.status || "").toLowerCase() === "healthy"),
      status: voicebox.body?.status || (voicebox.ok ? "unknown" : "down"),
      error: voicebox.error || null,
    },
    proxy: {
      ok: Boolean(proxyProc),
      healthUnauthed: proxyLocal.status || null,
      note: "Public /health requires HMAC; unauthenticated 401 is expected.",
    },
    pipecat: {
      ok: Boolean(pipecat.ok || pipecatProc),
      reachable: Boolean(pipecat.ok),
      optional: true,
    },
    tunnel: {
      cloudflaredRunning: Boolean(cloudflared),
      hostname: process.env.VOICEBOX_TUNNEL_HOSTNAME || "aura-voice.ifcdcbarbersapp.com",
    },
    macAsleep: false,
    host: os.hostname(),
    productionActivation: "OFF",
    voiceboxPrimary: 0,
  });

  if (!isMacVoiceOnline(runtime)) {
    console.log("[aura/voice-monitor] OFFLINE", runtime.voicebox?.status || "down");
  } else {
    console.log("[aura/voice-monitor] voicebox healthy; public ONLINE only after authenticated tunnel health");
  }
}

async function main() {
  console.log("[aura/voice-monitor] start", { root: ROOT, intervalMs: INTERVAL_MS });
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.warn("[aura/voice-monitor] tick", sanitizeLog(e?.message || e));
      writeVoiceRuntime({
        voicebox: { ok: false, status: "monitor_error" },
        proxy: { ok: false },
        pipecat: { ok: false },
        tunnel: { cloudflaredRunning: false },
        macAsleep: false,
        error: String(e?.message || e).slice(0, 160),
        productionActivation: "OFF",
        voiceboxPrimary: 0,
      });
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
