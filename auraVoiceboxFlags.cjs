/**
 * Voicebox is a PARALLEL TTS provider. Production Twilio <Say>/Polly stays
 * until Tessa sets VOICEBOX_PRIMARY=1. Default is off so Render never depends
 * on the Founder Mac. Does not change booking, PayPal, entitlements, or Twilio.
 */

const {
  voiceboxTunnelSecret,
  voiceboxUsesTunnelAuth,
  isLoopbackBase,
} = require("./auraVoiceboxTunnelAuth.cjs");

function envFlagOn(name) {
  const v = String(process.env[name] || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function voiceboxBaseUrl() {
  return String(process.env.VOICEBOX_BASE_URL || "http://127.0.0.1:17493").trim().replace(/\/$/, "");
}

function isVoiceboxPrimary() {
  return envFlagOn("VOICEBOX_PRIMARY");
}

function voiceboxTunnelHostname() {
  return String(process.env.VOICEBOX_TUNNEL_HOSTNAME || "aura-voice.ifcdcbarbersapp.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

function voiceboxFlags() {
  const { FOUNDER_APPROVED_VOICE } = require("./auraVoiceboxProfile.cjs");
  const engineOverride = String(process.env.VOICEBOX_ENGINE || "").trim();
  const baseUrl = voiceboxBaseUrl();
  const tunnelAuth = voiceboxUsesTunnelAuth(baseUrl);
  return {
    primary: isVoiceboxPrimary(),
    baseUrl,
    timeoutMs: Math.max(1500, envNum("VOICEBOX_TIMEOUT_MS", 8000)),
    healthTimeoutMs: Math.max(400, envNum("VOICEBOX_HEALTH_TIMEOUT_MS", 2000)),
    healthTtlMs: Math.max(500, envNum("VOICEBOX_HEALTH_TTL_MS", 4000)),
    profileName:
      String(process.env.VOICEBOX_PROFILE_NAME || FOUNDER_APPROVED_VOICE.name).trim() ||
      FOUNDER_APPROVED_VOICE.name,
    preferredEngine: engineOverride || "kokoro",
    preferredModelSize: String(process.env.VOICEBOX_MODEL_SIZE || "").trim() || null,
    stream: String(process.env.VOICEBOX_STREAM || "1").trim() !== "0",
    maxChunkChars: Math.min(5000, Math.max(100, envNum("VOICEBOX_MAX_CHUNK_CHARS", 120))),
    crossfadeMs: Math.min(500, Math.max(0, envNum("VOICEBOX_CROSSFADE_MS", 40))),
    hePollyFallback: String(process.env.VOICEBOX_HE_POLLY_FALLBACK || "1").trim() !== "0",
    productionActivation: "OFF",
    tunnelHostname: voiceboxTunnelHostname(),
    tunnelAuth,
    tunnelSecretConfigured: Boolean(voiceboxTunnelSecret()),
    loopback: isLoopbackBase(baseUrl),
    note:
      "VOICEBOX_PRIMARY default 0. Founder-approved Sample A (Kokoro af_heart) is the test identity only. Production Polly/Twilio Say stays until Tessa enables. Render uses VOICEBOX_BASE_URL HTTPS tunnel host + VOICEBOX_TUNNEL_SECRET HMAC; never Voicebox 127.0.0.1 admin.",
  };
}

module.exports = {
  envFlagOn,
  voiceboxBaseUrl,
  isVoiceboxPrimary,
  voiceboxTunnelHostname,
  voiceboxFlags,
};
