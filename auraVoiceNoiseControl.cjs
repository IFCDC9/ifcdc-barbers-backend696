/**
 * AURA ADVANCED SPEECH ISOLATION (safe configuration for the live voice stack)
 * --------------------------------------------------------------------------
 * PRIMARY PRODUCTION PATH = Twilio Voice Gather → SpeechResult + Confidence → backend
 *   • Raw telephony audio is NEVER available to this Node process on Gather.
 *   • Front-end DSP / RNNoise / true speaker diarization CANNOT run before STT.
 *   • Twilio performs carrier echo cancellation + STT; we gate transcripts aggressively.
 *
 * OPTIONAL PATH = Twilio Media Streams → μ-law frames → OpenAI Realtime
 *   • We can energy-gate / require sustained speech before forwarding frames.
 *   • Still NOT full speaker isolation / voiceprint lock.
 *
 * CALLER-VOICE LOCK / biometric voiceprints: NOT SUPPORTED on the Gather stack.
 * Do not claim speaker isolation unless validated with Media Streams + a real diarizer.
 *
 * Env (optional):
 *   AURA_VOICE_MIN_SPEECH_CONFIDENCE
 *   AURA_VOICE_BARGEIN_MIN_CONFIDENCE
 *   AURA_VOICE_CONFIRM_BELOW
 *   AURA_VOICE_NOISY_MIN_CONFIDENCE
 *   AURA_VOICE_NOISY_BARGEIN_MIN_CONFIDENCE
 *   AURA_VOICE_MIN_BARGEIN_CHARS
 *   AURA_VOICE_NOISE_CONTROL=0
 */

const lastAssistantByCall = new Map();
const pendingConfirmByCall = new Map();
/** @type {Map<string, { noisy: boolean, lowConfStreak: number, rejectStreak: number, updatedAt: number }>} */
const callNoiseState = new Map();

const noiseStats = {
  evaluated: 0,
  accepted: 0,
  rejectedNoise: 0,
  rejectedEcho: 0,
  rejectedFragment: 0,
  rejectedIrrelevant: 0,
  askedRepeat: 0,
  askedCloser: 0,
  askedSingleSpeaker: 0,
  confirmCritical: 0,
  noisyModeEnter: 0,
  noisyModeExit: 0,
  criticalBlocked: 0,
};

const CAP = 2000;

/** Honest capability flags for ops / status. */
const SPEECH_ISOLATION_CAPABILITIES = Object.freeze({
  gatherPathRawAudioAccess: false,
  preTranscriptionDsp: false,
  callerVoiceLock: false,
  biometricVoiceprint: false,
  trueSpeakerDiarization: false,
  twilioEnhancedStt: true,
  postSttConfidenceGating: true,
  noisyEnvironmentMode: true,
  realtimeMulawEnergyGate: true,
  realtimeSustainedBargeIn: true,
  note:
    "Primary AURA phone path uses Twilio Gather STT. Server never receives raw caller audio before transcription, so true speech enhancement / speaker lock cannot run pre-STT. Isolation is post-transcript gating + Twilio enhanced phone_call STT + optional Realtime μ-law energy gate.",
});

const PROMPTS = {
  repeat: "I didn't catch that clearly. Could you say that again for me?",
  closer:
    "There's some background noise on the line. Please speak a little closer to the phone.",
  multi: "I'm hearing multiple voices. Could you please speak directly into the phone?",
};

const BARBERSHOP_RELEVANCE =
  /\b(i|me|my|we|book|booking|appointment|schedule|reschedule|cancel|haircut|fade|taper|beard|lineup|buzz|barber|cut|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|o'?clock|am|pm|price|cost|hours|open|close|yes|no|yeah|yep|correct|hello|hi|help|service|name)\b/i;

const CRITICAL_ACTION =
  /\b(cancel|cancellation|reschedule|change (?:my )?appointment|delete|remove (?:my )?booking)\b/i;

const CRITICAL_SLOT =
  /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\+?1?\d{10}|\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|haircut|fade|taper|beard|lineup|buzz|dollars?|\$\d+)\b/i;

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

function getCallNoiseState(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return { noisy: false, lowConfStreak: 0, rejectStreak: 0, updatedAt: Date.now() };
  let st = callNoiseState.get(k);
  if (!st) {
    st = { noisy: false, lowConfStreak: 0, rejectStreak: 0, updatedAt: Date.now() };
    callNoiseState.set(k, st);
    pruneMap(callNoiseState);
  }
  return st;
}

function getNoiseThresholds(callSid) {
  const st = getCallNoiseState(callSid);
  const base = {
    minSpeechConfidence: Math.min(0.9, Math.max(0.2, envNum("AURA_VOICE_MIN_SPEECH_CONFIDENCE", 0.5))),
    bargeInMinConfidence: Math.min(0.95, Math.max(0.35, envNum("AURA_VOICE_BARGEIN_MIN_CONFIDENCE", 0.72))),
    confirmCriticalBelow: Math.min(0.98, Math.max(0.4, envNum("AURA_VOICE_CONFIRM_BELOW", 0.78))),
    minBargeInChars: Math.max(4, Math.floor(envNum("AURA_VOICE_MIN_BARGEIN_CHARS", 14))),
    minBargeInWords: Math.max(1, Math.floor(envNum("AURA_VOICE_MIN_BARGEIN_WORDS", 3))),
    minListenWords: Math.max(1, Math.floor(envNum("AURA_VOICE_MIN_LISTEN_WORDS", 1))),
  };
  if (!st.noisy) return { ...base, noisy: false };
  return {
    minSpeechConfidence: Math.min(
      0.95,
      Math.max(base.minSpeechConfidence, envNum("AURA_VOICE_NOISY_MIN_CONFIDENCE", 0.62)),
    ),
    bargeInMinConfidence: Math.min(
      0.98,
      Math.max(base.bargeInMinConfidence, envNum("AURA_VOICE_NOISY_BARGEIN_MIN_CONFIDENCE", 0.8)),
    ),
    confirmCriticalBelow: Math.min(0.98, Math.max(base.confirmCriticalBelow, 0.85)),
    minBargeInChars: base.minBargeInChars + 4,
    minBargeInWords: base.minBargeInWords + 1,
    minListenWords: Math.max(base.minListenWords, 2),
    noisy: true,
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

function looksLikeBackgroundMedia(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  if (
    /\b(coming up next|stay tuned|commercial break|subscribe|like and subscribe|breaking news|weather forecast|traffic report|now playing|you're listening to|brought to you by|live from|tune in|sportscaster|anchorman|dj)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  const words = tokenize(t);
  if (
    words.length >= 22 &&
    !/\b(i|me|my|book|appointment|haircut|barber|today|tomorrow|friday|monday|cancel|reschedule)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function looksLikeMultiSpeaker(text) {
  const t = String(text || "");
  if (/\b(he said|she said|they said|in the background|someone said|over there)\b/i.test(t)) return true;
  const quotes = t.match(/"[^"]{3,}"/g);
  if (quotes && quotes.length >= 2) return true;
  return false;
}

function looksLikeShortNoiseFragment(text, { isBargeInCandidate, thresholds }) {
  const t = String(text || "").trim();
  const words = tokenize(t);
  if (isBargeInCandidate) {
    if (t.length < thresholds.minBargeInChars) return true;
    if (words.length < thresholds.minBargeInWords) return true;
  } else if (words.length < thresholds.minListenWords && t.length < 3) {
    return true;
  }
  // Single interjection / far-room blurt while AURA talks
  if (isBargeInCandidate && words.length <= 2 && !BARBERSHOP_RELEVANCE.test(t)) return true;
  return false;
}

function conversationallyRelevant(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (BARBERSHOP_RELEVANCE.test(t)) return true;
  // Short confirmations / names after a question
  if (/^[a-zA-Z][a-zA-Z'\-]+(?:\s+[a-zA-Z][a-zA-Z'\-]+)?$/.test(t) && tokenize(t).length <= 3) return true;
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

function updateNoisyMode(callSid, { confidence, rejected, backgroundHit }) {
  const st = getCallNoiseState(callSid);
  const prev = st.noisy;
  if (rejected || backgroundHit || (confidence != null && confidence < 0.55)) {
    st.lowConfStreak += confidence != null && confidence < 0.55 ? 1 : 0;
    st.rejectStreak += rejected || backgroundHit ? 1 : 0;
  } else {
    st.lowConfStreak = Math.max(0, st.lowConfStreak - 1);
    st.rejectStreak = Math.max(0, st.rejectStreak - 1);
  }
  if (!st.noisy && (st.rejectStreak >= 2 || st.lowConfStreak >= 3 || backgroundHit)) {
    st.noisy = true;
    noiseStats.noisyModeEnter += 1;
  } else if (st.noisy && st.rejectStreak === 0 && st.lowConfStreak === 0) {
    st.noisy = false;
    noiseStats.noisyModeExit += 1;
  }
  st.updatedAt = Date.now();
  if (prev !== st.noisy) {
    console.log("[aura/noise] NOISY_ENVIRONMENT_MODE", { callSid, noisy: st.noisy });
  }
  return st;
}

function rejectPrompt(callSid, prompt, reason, confidence, t0, extra = {}) {
  const st = updateNoisyMode(callSid, {
    confidence,
    rejected: true,
    backgroundHit: reason === "background_media",
  });
  return {
    action: "reject_prompt",
    text: "",
    prompt,
    confidence,
    reason,
    noisyMode: st.noisy,
    metrics: { gateMs: Date.now() - t0, ...extra },
  };
}

/**
 * Evaluate Twilio speech before intent / booking processing.
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
  const thresholds = getNoiseThresholds(callSid);
  const digitsOk = String(digits || "").trim();

  if (digitsOk) {
    noiseStats.accepted += 1;
    updateNoisyMode(callSid, { confidence: 1, rejected: false });
    return {
      action: "accept",
      text: digitsOk,
      confidence: 1,
      reason: "dtmf",
      noisyMode: getCallNoiseState(callSid).noisy,
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
      noisyMode: getCallNoiseState(callSid).noisy,
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
      noisyMode: false,
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  const sid = String(callSid || "").trim();
  const pending = sid ? pendingConfirmByCall.get(sid) : null;
  const text = String(speechText || "").trim();
  const confidence = parseConfidence(confidenceRaw);

  if (pending && text) {
    if (/\b(yes|yeah|yep|correct|right|that's right|that is correct|confirm)\b/i.test(text)) {
      pendingConfirmByCall.delete(sid);
      noiseStats.accepted += 1;
      updateNoisyMode(callSid, { confidence: confidence ?? 0.9, rejected: false });
      return {
        action: "use_pending",
        text: pending.text,
        confidence: pending.confidence,
        reason: "critical_confirmed",
        noisyMode: getCallNoiseState(callSid).noisy,
        metrics: { gateMs: Date.now() - t0 },
      };
    }
    if (/\b(no|nope|wrong|incorrect|not right|try again)\b/i.test(text)) {
      pendingConfirmByCall.delete(sid);
      noiseStats.askedRepeat += 1;
      return rejectPrompt(callSid, PROMPTS.repeat, "critical_rejected", confidence, t0);
    }
  }

  if (!text) {
    noiseStats.askedRepeat += 1;
    return rejectPrompt(callSid, PROMPTS.repeat, "empty", confidence, t0);
  }

  const lastAsst = sid ? lastAssistantByCall.get(sid) : "";
  if (lastAsst && overlapRatio(text, lastAsst) >= 0.65 && text.length > 10) {
    noiseStats.rejectedEcho += 1;
    return rejectPrompt(callSid, PROMPTS.closer, "echo_overlap", confidence, t0);
  }

  if (looksLikeBackgroundMedia(text)) {
    noiseStats.rejectedNoise += 1;
    return rejectPrompt(callSid, PROMPTS.closer, "background_media", confidence, t0);
  }

  if (looksLikeMultiSpeaker(text)) {
    noiseStats.askedSingleSpeaker += 1;
    return rejectPrompt(callSid, PROMPTS.multi, "multi_speaker", confidence, t0);
  }

  if (looksLikeShortNoiseFragment(text, { isBargeInCandidate, thresholds })) {
    noiseStats.rejectedFragment += 1;
    return rejectPrompt(
      callSid,
      isBargeInCandidate ? PROMPTS.closer : PROMPTS.repeat,
      isBargeInCandidate ? "bargein_too_short" : "fragment",
      confidence,
      t0,
    );
  }

  // Distant chatter / TV often yields fluent-looking text with no caller relevance
  if (isBargeInCandidate && !conversationallyRelevant(text)) {
    noiseStats.rejectedIrrelevant += 1;
    return rejectPrompt(callSid, PROMPTS.closer, "irrelevant_bargein", confidence, t0);
  }
  if (thresholds.noisy && text.length > 8 && !conversationallyRelevant(text)) {
    noiseStats.rejectedIrrelevant += 1;
    return rejectPrompt(callSid, PROMPTS.closer, "irrelevant_noisy", confidence, t0);
  }

  const minConf = isBargeInCandidate ? thresholds.bargeInMinConfidence : thresholds.minSpeechConfidence;
  if (confidence != null && confidence < minConf) {
    // Hard-block critical commands/slots on low confidence — never guess
    if (CRITICAL_ACTION.test(text) || CRITICAL_SLOT.test(text)) {
      noiseStats.criticalBlocked += 1;
      noiseStats.askedRepeat += 1;
      return rejectPrompt(callSid, PROMPTS.repeat, "critical_low_confidence", confidence, t0, {
        minConf,
      });
    }
    noiseStats.askedCloser += 1;
    const prompt = confidence < thresholds.minSpeechConfidence * 0.9 ? PROMPTS.repeat : PROMPTS.closer;
    if (prompt === PROMPTS.repeat) noiseStats.askedRepeat += 1;
    return rejectPrompt(
      callSid,
      prompt,
      isBargeInCandidate ? "bargein_low_confidence" : "low_confidence",
      confidence,
      t0,
      { minConf },
    );
  }

  // Missing confidence on barge-in during noisy mode → do not interrupt
  if (isBargeInCandidate && confidence == null && thresholds.noisy) {
    noiseStats.rejectedFragment += 1;
    return rejectPrompt(callSid, PROMPTS.closer, "bargein_missing_confidence_noisy", confidence, t0);
  }

  const critical = extractCriticalSummary(text);
  const mustConfirm =
    Boolean(critical) &&
    (thresholds.noisy ||
      (confidence != null && confidence < thresholds.confirmCriticalBelow) ||
      CRITICAL_ACTION.test(text));

  if (mustConfirm && critical && !pending) {
    noiseStats.confirmCritical += 1;
    if (sid) {
      pendingConfirmByCall.set(sid, { text, confidence, critical });
      pruneMap(pendingConfirmByCall);
    }
    updateNoisyMode(callSid, { confidence: confidence ?? 0.6, rejected: false });
    return {
      action: "confirm_critical",
      text,
      prompt: `I heard ${critical}. Is that correct?`,
      confidence,
      reason: "confirm_critical",
      requireCriticalConfirm: true,
      noisyMode: getCallNoiseState(callSid).noisy,
      metrics: { gateMs: Date.now() - t0 },
    };
  }

  noiseStats.accepted += 1;
  updateNoisyMode(callSid, { confidence: confidence ?? 0.8, rejected: false });
  return {
    action: "accept",
    text,
    confidence,
    reason: "ok",
    noisyMode: getCallNoiseState(callSid).noisy,
    requireCriticalConfirm: Boolean(critical && thresholds.noisy),
    metrics: { gateMs: Date.now() - t0 },
  };
}

function getNoiseControlStats() {
  const evaluated = noiseStats.evaluated || 1;
  const rejected =
    noiseStats.rejectedNoise +
    noiseStats.rejectedEcho +
    noiseStats.rejectedFragment +
    noiseStats.rejectedIrrelevant +
    noiseStats.askedRepeat +
    noiseStats.askedCloser +
    noiseStats.askedSingleSpeaker;
  return {
    ...noiseStats,
    thresholds: getNoiseThresholds(null),
    capabilities: SPEECH_ISOLATION_CAPABILITIES,
    falseTriggerRejectRate:
      noiseStats.evaluated > 0 ? Number((rejected / evaluated).toFixed(3)) : null,
    acceptRate: noiseStats.evaluated > 0 ? Number((noiseStats.accepted / evaluated).toFixed(3)) : null,
  };
}

function getVoiceStackReport() {
  return {
    telephonyAudio: {
      handler: "Twilio Programmable Voice (PSTN/SIP)",
      kind: "native_twilio",
    },
    speechToText: {
      primary: "Twilio <Gather> SpeechResult (enhanced phone_call model when enabled in TwiML)",
      kind: "native_twilio",
      optionalRealtime: "OpenAI Realtime input audio (Media Streams path only)",
    },
    voiceActivityDetection: {
      gather: "Twilio Gather end-of-speech (speechTimeout) + custom post-STT gates",
      realtime: "OpenAI server_vad + custom sustained μ-law energy gate",
      kind: "native_twilio + ai_model + custom_backend",
    },
    noiseSuppression: {
      gatherPreStt: "Not available — server never receives raw Gather audio",
      gatherPostStt: "Custom confidence / relevance / noisy-mode gating (auraVoiceNoiseControl.cjs)",
      realtime: "Custom μ-law energy + sustained-speech gate before model append",
      carrier: "Twilio/network echo cancellation on PSTN",
      kind: "native_twilio + custom_backend",
      callerVoiceLock: SPEECH_ISOLATION_CAPABILITIES.callerVoiceLock,
    },
    echoCancellation: {
      status: "Twilio/carrier AEC on phone calls; app echo-overlap reject on transcripts; Realtime clear-on-speech",
      kind: "native_twilio + custom_backend",
    },
    textToSpeech: {
      primary: "Amazon Polly via Twilio <Say>",
      optionalRealtime: "OpenAI Realtime audio.delta",
      kind: "native_twilio + ai_model",
    },
    bargeIn: {
      gather: "Twilio bargeIn=true + higher confidence / sustained-length filters while interrupting",
      realtime: "interrupt_response + sustained energy while assistant speaking",
      kind: "native_twilio + custom_backend + ai_model",
    },
    capabilities: SPEECH_ISOLATION_CAPABILITIES,
  };
}

function twilioGatherSpeechAttrs(callSid) {
  const noisy = getCallNoiseState(callSid).noisy;
  return {
    enhanced: "true",
    speechModel: "phone_call",
    bargeIn: "true",
    // Slightly longer end-of-speech in noisy mode reduces choppy false fragments
    timeout: noisy ? "6" : "5",
    speechTimeout: noisy ? "2" : "1",
  };
}

/**
 * Per-connection μ-law gate for Media Streams (Realtime).
 * Requires sustained energy (~300ms) before barge-in frames are forwarded.
 */
function createMulawSpeechGate() {
  let noiseFloor = 6;
  let speechRunMs = 0;
  const FRAME_MS = 20;

  function energyOf(base64Payload) {
    const b64 = String(base64Payload || "");
    if (!b64) return 0;
    let buf;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return 99; // fail open
    }
    if (!buf.length) return 0;
    let sum = 0;
    let n = 0;
    const step = Math.max(1, Math.floor(buf.length / 80));
    for (let i = 0; i < buf.length; i += step) {
      const u = buf[i] ^ 0xff;
      sum += u & 0x7f;
      n += 1;
    }
    return n ? sum / n : 0;
  }

  return {
    shouldForward(base64Payload, { assistantSpeaking = false } = {}) {
      const energy = energyOf(base64Payload);
      if (energy <= 0) return false;

      // Adaptive stationary noise floor (HVAC / fan / idle line)
      if (energy < noiseFloor + 1.5) {
        noiseFloor = noiseFloor * 0.97 + energy * 0.03;
        speechRunMs = 0;
        return false;
      }

      const listenMargin = envNum("AURA_VOICE_MULAW_LISTEN_MARGIN", 3.5);
      const bargeMargin = envNum("AURA_VOICE_MULAW_BARGE_MARGIN", 7.5);
      const minEnergy = noiseFloor + (assistantSpeaking ? bargeMargin : listenMargin);

      if (energy < minEnergy) {
        speechRunMs = 0;
        return false;
      }

      speechRunMs += FRAME_MS;
      const needMs = assistantSpeaking
        ? envNum("AURA_VOICE_BARGEIN_SUSTAIN_MS", 300)
        : envNum("AURA_VOICE_LISTEN_SUSTAIN_MS", 80);
      if (speechRunMs < needMs) return false;
      return true;
    },
    getNoiseFloor: () => noiseFloor,
  };
}

/** @deprecated use createMulawSpeechGate — kept for tests */
function shouldForwardMulawFrame(base64Payload, opts = {}) {
  if (!shouldForwardMulawFrame._gate) shouldForwardMulawFrame._gate = createMulawSpeechGate();
  return shouldForwardMulawFrame._gate.shouldForward(base64Payload, opts);
}

module.exports = {
  evaluateSpeechInput,
  rememberAssistantSpeech,
  getNoiseThresholds,
  getNoiseControlStats,
  getVoiceStackReport,
  twilioGatherSpeechAttrs,
  createMulawSpeechGate,
  shouldForwardMulawFrame,
  parseConfidence,
  extractCriticalSummary,
  looksLikeBackgroundMedia,
  looksLikeMultiSpeaker,
  conversationallyRelevant,
  SPEECH_ISOLATION_CAPABILITIES,
  PROMPTS,
};
