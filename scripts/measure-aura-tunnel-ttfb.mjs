/**
 * Measure TTFB including Cloudflare tunnel + allowlisted proxy overhead.
 * Does not set VOICEBOX_PRIMARY. Uses HMAC (VOICEBOX_TUNNEL_SECRET).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const { isValidAudio } = require("../auraVoiceboxBridge.cjs");
const { FOUNDER_APPROVED_VOICE } = require("../auraVoiceboxProfile.cjs");
const { voiceboxFlags } = require("../auraVoiceboxFlags.cjs");
const { voiceboxTunnelSecret } = require("../auraVoiceboxTunnelAuth.cjs");

const secretFile = join(root, "data", "aura-voicebox-tunnel.secret");
if (!process.env.VOICEBOX_TUNNEL_SECRET && existsSync(secretFile)) {
  process.env.VOICEBOX_TUNNEL_SECRET = readFileSync(secretFile, "utf8").trim();
}
process.env.VOICEBOX_TUNNEL_AUTH = process.env.VOICEBOX_TUNNEL_AUTH || "1";

async function main() {
  const flags = voiceboxFlags();
  const secret = voiceboxTunnelSecret();
  if (!secret) {
    console.log(JSON.stringify({ ok: false, skip: true, reason: "VOICEBOX_TUNNEL_SECRET missing" }, null, 2));
    return;
  }
  const client = createVoiceboxClient({ flags: { timeoutMs: 20000, baseUrl: flags.baseUrl } });
  const t0 = Date.now();
  let health;
  try {
    health = await client.health(4000);
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          online: false,
          ttfbMs: Date.now() - t0,
          error: String(e?.message || e).slice(0, 180),
          baseUrl: flags.baseUrl,
          loopback: flags.loopback,
          note: "Tunnel/auth/health fail → Polly. Not ONLINE.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  const healthMs = Date.now() - t0;
  const profiles = await client.listProfiles().catch(() => []);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  const started = Date.now();
  const streamed = await client.generateStreamMeta(
    {
      profile_id: profile?.id,
      text: "Absolutely...",
      language: "en",
      engine: "kokoro",
      instruct: FOUNDER_APPROVED_VOICE.instruct,
      personality: false,
      normalize: true,
    },
    20000,
  );
  const out = {
    ok: isValidAudio(streamed.buffer),
    online: String(health?.status).toLowerCase() === "healthy",
    baseUrl: flags.baseUrl,
    healthMs,
    firstByteMs: streamed.firstByteMs,
    totalMs: streamed.totalMs,
    includesTunnelHop: !flags.loopback,
    sample: "A",
    voiceId: "af_heart",
    publicName: "Aura",
    voiceboxPrimary: 0,
    bytes: streamed.buffer?.length || 0,
    elapsedMs: Date.now() - started,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok || !out.online) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
