/**
 * Voicebox is a PARALLEL TTS provider. Production Twilio <Say>/Polly stays
 * until Tessa sets VOICEBOX_PRIMARY=1. Default is off so Render never depends
 * on the Founder Mac. Does not change booking, PayPal, entitlements, or Twilio.
 */

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

function voiceboxFlags() {
  return {
    primary: isVoiceboxPrimary(),
    baseUrl: voiceboxBaseUrl(),
    timeoutMs: Math.max(1500, envNum("VOICEBOX_TIMEOUT_MS", 8000)),
    healthTimeoutMs: Math.max(400, envNum("VOICEBOX_HEALTH_TIMEOUT_MS", 2000)),
    healthTtlMs: Math.max(500, envNum("VOICEBOX_HEALTH_TTL_MS", 4000)),
    profileName: String(process.env.VOICEBOX_PROFILE_NAME || "AURA ALLAH").trim() || "AURA ALLAH",
    preferredEngine: String(process.env.VOICEBOX_ENGINE || "").trim() || null,
    preferredModelSize: String(process.env.VOICEBOX_MODEL_SIZE || "1.7B").trim() || "1.7B",
    stream: String(process.env.VOICEBOX_STREAM || "1").trim() !== "0",
    note:
      "VOICEBOX_PRIMARY default 0. Production Polly/Twilio Say stays until Tessa enables. Render cannot reach Founder Mac 127.0.0.1 unless VOICEBOX_BASE_URL is a tunnel.",
  };
}

module.exports = {
  envFlagOn,
  voiceboxBaseUrl,
  isVoiceboxPrimary,
  voiceboxFlags,
};
