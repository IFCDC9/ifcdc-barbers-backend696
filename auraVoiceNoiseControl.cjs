/**
 * AURA Voice Noise Control — lightweight speech quality gate.
 *
 * Works on Twilio Gather confidence + transcript heuristics (primary production path).
 * Does not change Twilio credentials, booking commit rules, payments, or A2P.
 *
 * Env (optional):
 *   AURA_VOICE_MIN_SPEECH_CONFIDENCE   default 0.42  (soft voices still accepted)
 *   AURA_VOICE_BARGEIN_MIN_CONFIDENCE  default 0.58  (noise less likely to barge-in)
 *   AURA_VOICE_CONFIRM_BELOW           default 0.70  (confirm critical slots when noisy)
 *   AURA_VOICE_NOISE_CONTROL=0         disable gate (accept all)
 */

const lastAssistantByCall = new Map();
const pendingConfirmByCall = new Map();
const noiseStats = {
  evaluated: 0,
  accepted: 0,
  rejectedNoise: 0,
  rejectedEcho: 0,
  askedRepeat: 0,
  askedCloser: 0,
  askedSingleSpeaker: 0,
  confirmCritical: 0,
};

const CAP = 2000;

function pruneMap(map) {
  while (map.size > CAP) {
    const k = map.keys().next().value;
    if (k === undefined) break;
    map.delete(k);
  }
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function noiseControlEnabled() {
  return String(process.env.AURA_VOICE_NOISE_CONTROL || "1").trim() !== "0";
}

function getNoiseThresholds() {
  return {
    minSpeechConfidence: Math.min(0.9, Math.max(0.15, envNum("AURA_VOICE_MIN_SPEECH_CONFIDENCE", 0.42))),
    bargeInMinConfidence: Math.min(0.95, Math.max(0.2, envNum("AURA_VOICE_BARGEIN_MIN_CONFIDENCE", 0.58))),
    confirmCriticalBelow: Math.min(0.95, Math.max(0.3, envNum("AURA_VOICE_CONFIRM_BELOW", 0.7))),
  };
}

function rememberAssistantSpeech(callSid, text) {
  const k = String(callSid || "").trim();
  if (!k) return;
  lastAssistantByCall.set(k, String(text || "").trim().toLowerCase().slice(0, 800));
  pruneMap(lastAssistantByCall);
}

function parseConfidence(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Twilio usually sends 0–1; some accounts send 0–100
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function overlapRatio(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit += 1;
  return hit / Math.min(ta.size, tb.size);
}

/** Heuristic: transcript looks like TV/radio/chatter rather than a phone caller. */
function looksLikeBackgroundMedia(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (
    /\b(coming up next|stay tuned|commercial break|subscribe|like and subscribe|breaking news|weather forecast|traffic report|now playing|you're listening to)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // Very long, multi-clause monologue with no second-person address often = media bleed
  const words = tokenize(t);
  if (words.length >= 28 && !/\b(i|me|my|book|appointment|haircut|barber|today|tomorrow|friday|monday)\b/i.test(t)) {
    return true;
  }
  return false;
}

function looksLikeMultiSpeaker(text) {
  const t = String(text || "");
  if (/\b(he said|she said|they said|in the background|someone said)\b/i.test(t)) return true;
  // Two distinct quoted fragments
  const quotes = t.match(/"[^"]{3,}"/g);
  if (quotes && quotes.length >= 2) return true;
  return false;
}

function extractCriticalSummary(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const parts = [];
  const phone = t.match(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/);
  if (phone) parts.push(`phone number ${phone[0]}`);
  const time = t.match(
    /\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?))\b/i,
  );
  if (time) parts.push(time[0].replace(/^at\s+/i, "").trim());
  const day = t.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+)\b/i,
  );
  if (day) parts.push(day[0]);
  const name = t.match(/\b(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (name) parts.push(`name ${name[1]}`);
  const service = t.match(/\b(haircut|fade|taper|beard|lineup|buzz|kids?\s*cut|design)\b/i);
  if (service) parts.push(service[0]);
  const barber = t.match(/\b(?:with|barber)\s+([A-Z][a-z]{2,})\b/);
  if (barber) parts.push(`barber ${barber[1]}`);
  if (!parts.length) return null;
  return parts.join(", ");
}

const PROMPTS = {
  repeat:
    "I'm having a little trouble hearing you clearly. Could you repeat that?",
  closer:
    "There's some background noise on the line. Please speak a little closer to the phone.",
  multi:
    "I'm hearing multiple voices. Could you please speak directly into the phone?",
};

/**
 * Evaluate Twilio speech for noise / echo / confidence before intent processing.
 * @returns {{
 *   action: 'accept'|'reject_prompt'|'confirm_critical'|'use_pending',
 *   text: string,
 *   prompt?: string,
 *   confidence: number|null,
 *   reason?: string,
 *   requireCriticalConfirm?: boolean,
 *   metrics?: object
 * }}
 */
function evaluateSpeechInput({
  callSid,
  speechText,
  confidenceRaw,
  digits,
  isWelcome,
  isNoSpeech,
  isBargeInCandidate = false,
} = {}) {
  const t0 = Date.now();
  noiseStats.evaluated += 1;
  const thresholds = getNoiseThresholds();
  const digitsOk = String(digits || "").trim();
  if (digitsOk) {
    noiseStats.accepted += 1;
    return {
      action: "accept",
      text: digitsOk,
      confidence: 1,
      reason: "dtmf",
      metrics: { gateMs: Date.now() - t0 },
    };
  }
  if (isWelcome || isNoSpeech) {
    noiseStats.accepted += 1;
    return {
      action: "accept",
      text: speechText,
      confidence: null,
      reason: isWelcome ? "welcome" : "no_speech_sentinel",
      metrics: { gateMs: Date.now() - t0 },
    };
  }
  if (!noiseControlEnabled()) {
    noiseStats.accepted += 1;
    return {
      action: "accept",
      text: String(speechText || "").trim(),
      confidence: parseConfidence(confidenceRaw),
      reason: "disabled",
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  const sid = String(callSid || "").trim();
  const pending = sid ? pendingConfirmByCall.get(sid) : null;
  const text = String(speechText || "").trim();
  const confidence = parseConfidence(confidenceRaw);

  // Resolve pending critical confirmation
  if (pending && text) {
    if (/\b(yes|yeah|yep|correct|right|that's right|that is correct|confirm)\b/i.test(text)) {
      pendingConfirmByCall.delete(sid);
      noiseStats.accepted += 1;
      return {
        action: "use_pending",
        text: pending.text,
        confidence: pending.confidence,
        reason: "critical_confirmed",
        metrics: { gateMs: Date.now() - t0 },
      };
    }
    if (/\b(no|nope|wrong|incorrect|not right|try again)\b/i.test(text)) {
      pendingConfirmByCall.delete(sid);
      noiseStats.askedRepeat += 1;
      return {
        action: "reject_prompt",
        text: "",
        prompt: PROMPTS.repeat,
        confidence,
        reason: "critical_rejected",
        metrics: { gateMs: Date.now() - t0 },
      };
    }
  }

  if (!text) {
    noiseStats.askedRepeat += 1;
    return {
      action: "reject_prompt",
      text: "",
      prompt: PROMPTS.repeat,
      confidence,
      reason: "empty",
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  // Echo / feedback: caller transcript overlaps recent AURA speech
  const lastAsst = sid ? lastAssistantByCall.get(sid) : "";
  if (lastAsst && overlapRatio(text, lastAsst) >= 0.72 && text.length > 12) {
    noiseStats.rejectedEcho += 1;
    return {
      action: "reject_prompt",
      text: "",
      prompt: PROMPTS.closer,
      confidence,
      reason: "echo_overlap",
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  if (looksLikeBackgroundMedia(text)) {
    noiseStats.rejectedNoise += 1;
    return {
      action: "reject_prompt",
      text: "",
      prompt: PROMPTS.closer,
      confidence,
      reason: "background_media",
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  if (looksLikeMultiSpeaker(text)) {
    noiseStats.askedSingleSpeaker += 1;
    return {
      action: "reject_prompt",
      text: "",
      prompt: PROMPTS.multi,
      confidence,
      reason: "multi_speaker",
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  // Selective barge-in: require stronger confidence when interrupting AURA
  const minConf = isBargeInCandidate ? thresholds.bargeInMinConfidence : thresholds.minSpeechConfidence;
  if (confidence != null && confidence < minConf) {
    noiseStats.askedCloser += 1;
    const prompt = confidence < thresholds.minSpeechConfidence * 0.85 ? PROMPTS.repeat : PROMPTS.closer;
    if (prompt === PROMPTS.repeat) noiseStats.askedRepeat += 1;
    return {
      action: "reject_prompt",
      text: "",
      prompt,
      confidence,
      reason: isBargeInCandidate ? "bargein_low_confidence" : "low_confidence",
      metrics: { gateMs: Date.now() - t0, minConf },
    };
  }

  // Critical slots in noisy conditions → confirm before intent/booking uses them
  const critical = extractCriticalSummary(text);
  if (
    critical &&
    confidence != null &&
    confidence < thresholds.confirmCriticalBelow &&
    !pending
  ) {
    noiseStats.confirmCritical += 1;
    if (sid) {
      pendingConfirmByCall.set(sid, { text, confidence, critical });
      pruneMap(pendingConfirmByCall);
    }
    return {
      action: "confirm_critical",
      text,
      prompt: `I heard ${critical}. Is that correct?`,
      confidence,
      reason: "confirm_critical",
      requireCriticalConfirm: true,
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  noiseStats.accepted += 1;
  return {
    action: "accept",
    text,
    confidence,
    reason: "ok",
    requireCriticalConfirm: Boolean(
      critical && confidence != null && confidence < thresholds.confirmCriticalBelow + 0.05,
    ),
    metrics: { gateMs: Date.now() - t0 },
  };
}

function getNoiseControlStats() {
  const evaluated = noiseStats.evaluated || 1;
  const rejected =
    noiseStats.rejectedNoise +
    noiseStats.rejectedEcho +
    noiseStats.askedRepeat +
    noiseStats.askedCloser +
    noiseStats.askedSingleSpeaker;
  return {
    ...noiseStats,
    thresholds: getNoiseThresholds(),
    falseTriggerRejectRate:
      noiseStats.evaluated > 0 ? Number((rejected / evaluated).toFixed(3)) : null,
    acceptRate: noiseStats.evaluated > 0 ? Number((noiseStats.accepted / evaluated).toFixed(3)) : null,
  };
}

/**
 * Gather attributes for Twilio enhanced phone STT (noise-robust).
 * Does not change account credentials — only TwiML recognition hints.
 */
function twilioGatherSpeechAttrs() {
  // enhanced + phone_call improve noisy line recognition on Twilio Speech
  return {
    enhanced: "true",
    speechModel: "phone_call",
    bargeIn: "true",
    timeout: "5",
    speechTimeout: "1",
  };
}

/**
 * Simple μ-law energy gate for Media Streams (Realtime path).
 * Drops near-silence / low-energy frames so background hiss is less likely to trigger VAD.
 */
function shouldForwardMulawFrame(base64Payload, { assistantSpeaking = false } = {}) {
  const b64 = String(base64Payload || "");
  if (!b64) return false;
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return true; // fail open
  }
  if (!buf.length) return false;
  // μ-law: magnitude from top bits; cheap energy proxy without full decode
  let sum = 0;
  const step = Math.max(1, Math.floor(buf.length / 80));
  let n = 0;
  for (let i = 0; i < buf.length; i += step) {
    const u = buf[i] ^ 0xff;
    const mag = u & 0x7f;
    sum += mag;
    n += 1;
  }
  const avg = n ? sum / n : 0;
  // Soft thresholds — do not kill soft speakers (avg often ~10–40 for speech)
  const minSpeech = envNum("AURA_VOICE_MULAW_MIN_ENERGY", 8);
  const minBarge = envNum("AURA_VOICE_MULAW_BARGE_ENERGY", 14);
  if (assistantSpeaking) return avg >= minBarge;
  return avg >= minSpeech;
}

module.exports = {
  evaluateSpeechInput,
  rememberAssistantSpeech,
  getNoiseThresholds,
  getNoiseControlStats,
  twilioGatherSpeechAttrs,
  shouldForwardMulawFrame,
  parseConfidence,
  extractCriticalSummary,
  looksLikeBackgroundMedia,
  looksLikeMultiSpeaker,
  PROMPTS,
};
