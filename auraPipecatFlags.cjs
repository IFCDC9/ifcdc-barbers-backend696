/**
 * Pipecat is a PARALLEL orchestration layer on the existing Aura / Twilio /
 * Voicebox path. It does not replace Aura brain, booking, Twilio console
 * config, or the Founder-approved Sample A profile.
 *
 * PIPECAT_ENABLED default 0 — test path only. Production live calls stay Polly
 * until Tessa sets VOICEBOX_PRIMARY=1 (and, separately, this flag).
 */

function envFlagOn(name) {
  const v = String(process.env[name] || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function isPipecatEnabled() {
  return envFlagOn("PIPECAT_ENABLED");
}

function pipecatSidecarUrl() {
  return String(process.env.PIPECAT_SIDECAR_URL || "http://127.0.0.1:8766").trim().replace(/\/$/, "");
}

function pipecatFlags() {
  return {
    enabled: isPipecatEnabled(),
    sidecarUrl: pipecatSidecarUrl(),
    sidecarTimeoutMs: Math.max(200, envNum("PIPECAT_SIDECAR_TIMEOUT_MS", 600)),
    silenceMs: Math.max(250, envNum("PIPECAT_SILENCE_MS", 650)),
    bargeInRms: Math.min(0.4, Math.max(0.005, envNum("PIPECAT_BARGEIN_RMS", 0.04))),
    firstPhraseBudgetMs: Math.max(800, envNum("PIPECAT_FIRST_PHRASE_BUDGET_MS", 6000)),
    restWaitMs: Math.max(500, envNum("PIPECAT_REST_WAIT_MS", 12000)),
    productionActivation: "OFF",
    note:
      "PIPECAT_ENABLED default 0. Orchestration (streaming, turn detection, barge-in, cancel, silence, pacing, language switch, recovery) only. Aura brain / booking / Sample A / production Polly stay put. Do not set VOICEBOX_PRIMARY=1 on Render.",
  };
}

module.exports = {
  envFlagOn,
  isPipecatEnabled,
  pipecatSidecarUrl,
  pipecatFlags,
};
