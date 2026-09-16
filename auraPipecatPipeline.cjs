/**
 * Aura × Pipecat orchestration (Node).
 *
 * Used for streaming/chunking, turn detection, barge-in, cancel speech,
 * silence, pacing, language switch, recovery. Aura brain, booking tools,
 * Twilio console config, and Voicebox Sample A (Kokoro af_heart) stay put.
 *
 * PIPECAT_ENABLED default 0. Production TTS remains Polly.
 */

const { isPipecatEnabled, pipecatFlags } = require("./auraPipecatFlags.cjs");
const { createMockTwilioStream, twilioHqStatus, pollyHqStatus } = require("./auraPipecatTwilio.cjs");
const { setCallLanguage, snapshotLedger, markBargeIn } = require("./auraVoiceCallRuntime.cjs");

const FIRST_PHRASE = {
  en: "Absolutely...",
  es: "Claro que sí...",
  he: "בהחלט...",
};

const GREETING_RE = /^\s*(hi|hello|hola|שלום)[,.]?\s+(this is Aura|soy Aura|כאן Aura)\b/i;

const stats = {
  streams: 0,
  firstPhrases: 0,
  interrupts: 0,
  recovers: 0,
  lastTtfbMs: null,
  lastFirstPhraseMs: null,
  lastTotalSynthMs: null,
  lastRtf: null,
  lastInterruptMs: null,
  lastRecoveryMs: null,
  lastFallbackMs: null,
  lastLanguage: null,
  lastError: null,
  lastOkAt: null,
};

const pendingRestByToken = new Map();
let lastTest = null;

function pcmRms(samples) {
  const arr = Array.isArray(samples) ? samples : [];
  if (!arr.length) return 0;
  let acc = 0;
  for (const n of arr) {
    const x = Number(n);
    if (!Number.isFinite(x)) continue;
    acc += x * x;
  }
  return Math.sqrt(acc / arr.length);
}

function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
  if (buf.slice(0, 4).toString("ascii") !== "RIFF") return 0;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataLen = buf.readUInt32LE(40);
  const bytesPerSec = sampleRate * channels * (bits / 8);
  if (!bytesPerSec) return 0;
  return Math.round((dataLen / bytesPerSec) * 1000);
}

function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Natural ack + rest. Never chops a short line or the Aura greeting mid-word.
 * Rest is the original spoken line (not a sliced fragment) so she does not
 * sound robotic.
 */
function splitForStreaming(text, language = "en") {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const lang = String(language || "en").toLowerCase().split(/[-_]/)[0] === "iw"
    ? "he"
    : String(language || "en").toLowerCase().split(/[-_]/)[0];
  const ack = FIRST_PHRASE[lang] || FIRST_PHRASE.en;
  if (!raw) return { first: "", rest: "", unchunked: true, reason: "empty" };
  if (GREETING_RE.test(raw)) return { first: raw, rest: "", unchunked: true, reason: "greeting" };
  if (raw.toLowerCase().startsWith(ack.toLowerCase().replace(/\.\.\.$/, ""))) {
    return { first: raw, rest: "", unchunked: true, reason: "already_ack" };
  }
  const words = wordCount(raw);
  if (words < 14 && raw.length < 90) {
    return { first: raw, rest: "", unchunked: true, reason: "short" };
  }
  return {
    first: ack,
    rest: raw,
    unchunked: false,
    reason: "ack_prefix",
  };
}

function createTurnDetector(opts = {}) {
  const flags = pipecatFlags();
  const silenceMs = Number(opts.silenceMs) > 0 ? Number(opts.silenceMs) : flags.silenceMs;
  const bargeInRms = Number(opts.bargeInRms) > 0 ? Number(opts.bargeInRms) : flags.bargeInRms;
  let speaking = false;
  let lastVoiceAt = 0;
  return {
    silenceMs,
    bargeInRms,
    pushPcm16(samples, now = Date.now()) {
      const rms = pcmRms(samples);
      if (rms >= bargeInRms) {
        speaking = true;
        lastVoiceAt = now;
        return { speaking: true, endOfTurn: false, bargeIn: true, silenceMs: 0, rms };
      }
      const sil = speaking && lastVoiceAt ? now - lastVoiceAt : speaking ? 0 : silenceMs;
      if (speaking && sil >= silenceMs) {
        speaking = false;
        return { speaking: false, endOfTurn: true, bargeIn: false, silenceMs: sil, rms };
      }
      return { speaking, endOfTurn: false, bargeIn: false, silenceMs: speaking ? sil : 0, rms };
    },
    reset() {
      speaking = false;
      lastVoiceAt = 0;
    },
  };
}

function switchCallLanguage(callSid, language) {
  const before = snapshotLedger(callSid);
  const nextLang = setCallLanguage(callSid, language);
  const after = snapshotLedger(callSid);
  return {
    language: nextLang,
    booking: after.booking,
    bookingPreserved: JSON.stringify(before.booking) === JSON.stringify(after.booking),
  };
}

function interruptSpeech(callSid) {
  const started = Date.now();
  markBargeIn(callSid);
  stats.interrupts += 1;
  stats.lastInterruptMs = Date.now() - started;
  return { cancelled: true, interruptMs: stats.lastInterruptMs };
}

async function recoverWithFallback(reason, fallbackFn) {
  const started = Date.now();
  stats.recovers += 1;
  let result = { ok: false, fallback: true, reason: String(reason || "error") };
  try {
    if (typeof fallbackFn === "function") result = await fallbackFn(reason);
  } catch (e) {
    result = { ok: false, fallback: true, reason: "recovery_error", error: String(e?.message || e).slice(0, 160) };
  }
  stats.lastRecoveryMs = Date.now() - started;
  stats.lastFallbackMs = stats.lastRecoveryMs;
  stats.lastError = String(reason || "").slice(0, 180);
  return { ...result, recovered: true, recoveryMs: stats.lastRecoveryMs, fallbackMs: stats.lastFallbackMs };
}

function rtfFor(audio, synthMs) {
  const dur = wavDurationMs(audio);
  const ms = Number(synthMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (!dur) return null;
  return Math.round((ms / dur) * 1000) / 1000;
}

function storePendingRest(token, row) {
  const key = String(token || "");
  if (!key) return;
  pendingRestByToken.set(key, { ...row, at: Date.now() });
  while (pendingRestByToken.size > 80) {
    const first = pendingRestByToken.keys().next().value;
    if (first === undefined) break;
    pendingRestByToken.delete(first);
  }
}

function takePendingRest(token) {
  const key = String(token || "");
  const row = pendingRestByToken.get(key) || null;
  if (row) pendingRestByToken.delete(key);
  return row;
}

function getPendingRest(token) {
  return pendingRestByToken.get(String(token || "")) || null;
}

function recordStreamMetrics(partial = {}) {
  if (partial.ttfbMs != null) stats.lastTtfbMs = Number(partial.ttfbMs);
  if (partial.firstPhraseMs != null) stats.lastFirstPhraseMs = Number(partial.firstPhraseMs);
  if (partial.totalSynthMs != null) stats.lastTotalSynthMs = Number(partial.totalSynthMs);
  if (partial.rtf != null) stats.lastRtf = Number(partial.rtf);
  if (partial.interruptMs != null) stats.lastInterruptMs = Number(partial.interruptMs);
  if (partial.recoveryMs != null) stats.lastRecoveryMs = Number(partial.recoveryMs);
  if (partial.fallbackMs != null) stats.lastFallbackMs = Number(partial.fallbackMs);
  if (partial.language) stats.lastLanguage = String(partial.language);
  stats.lastOkAt = new Date().toISOString();
}

function setLastTest(row) {
  lastTest = row && typeof row === "object" ? { ...row, at: row.at || new Date().toISOString() } : null;
  return lastTest;
}

function getLastTest() {
  return lastTest;
}

async function probePipecatSidecar() {
  const flags = pipecatFlags();
  const ac = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(flags.sidecarTimeoutMs)
    : undefined;
  try {
    const res = await fetch(`${flags.sidecarUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ac,
    });
    const body = await res.json().catch(() => null);
    return {
      reachable: res.ok,
      status: res.ok ? "STANDBY" : "UNHEALTHY",
      body,
      url: flags.sidecarUrl,
    };
  } catch (e) {
    return {
      reachable: false,
      status: "DOWN",
      error: String(e?.message || e).slice(0, 160),
      url: flags.sidecarUrl,
    };
  }
}

async function getPipecatHqStatus() {
  const flags = pipecatFlags();
  const sidecar = await probePipecatSidecar();
  return {
    status: flags.enabled ? (sidecar.reachable ? "TEST_PATH" : "ENABLED_SIDECAR_DOWN") : "OFF",
    enabled: flags.enabled,
    productionActivation: "OFF",
    sidecar,
    publicName: "Aura",
    sample: "A",
    role: "orchestration_only",
    metrics: { ...stats },
    lastTest,
    note: flags.note,
  };
}

function enabledHealth(voiceboxStatus) {
  if (String(voiceboxStatus) === "PRIMARY" && pipecatFlags().enabled) return "TEST_LIVE";
  if (pipecatFlags().enabled) return "PIPECAT_TEST";
  return "POLLY_PRODUCTION";
}

function getPipelineHealth(parts) {
  const vb = String(parts?.voicebox?.status || "UNKNOWN");
  const pc = String(parts?.pipecat?.status || "OFF");
  const tw = String(parts?.twilio?.status || "UNKNOWN");
  const po = String(parts?.polly?.status || "PRODUCTION_PRIMARY");
  return {
    status: enabledHealth(vb),
    voicebox: vb,
    pipecat: pc,
    twilio: tw,
    polly: po,
    productionPrimary: "OFF",
    note: "Production TTS is Polly. Voicebox + Pipecat are test/standby until Tessa enables VOICEBOX_PRIMARY.",
  };
}

function resetPipecatForTests() {
  stats.streams = 0;
  stats.firstPhrases = 0;
  stats.interrupts = 0;
  stats.recovers = 0;
  stats.lastTtfbMs = null;
  stats.lastFirstPhraseMs = null;
  stats.lastTotalSynthMs = null;
  stats.lastRtf = null;
  stats.lastInterruptMs = null;
  stats.lastRecoveryMs = null;
  stats.lastFallbackMs = null;
  stats.lastLanguage = null;
  stats.lastError = null;
  stats.lastOkAt = null;
  pendingRestByToken.clear();
  lastTest = null;
}

module.exports = {
  FIRST_PHRASE,
  splitForStreaming,
  createTurnDetector,
  switchCallLanguage,
  interruptSpeech,
  recoverWithFallback,
  rtfFor,
  wavDurationMs,
  storePendingRest,
  takePendingRest,
  getPendingRest,
  recordStreamMetrics,
  setLastTest,
  getLastTest,
  probePipecatSidecar,
  getPipecatHqStatus,
  getPipelineHealth,
  getPipecatStats: () => ({ ...stats }),
  isPipecatEnabled,
  pipecatFlags,
  createMockTwilioStream,
  twilioHqStatus,
  pollyHqStatus,
  resetPipecatForTests,
};
