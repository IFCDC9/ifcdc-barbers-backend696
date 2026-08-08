import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  evaluateSpeechInput,
  rememberAssistantSpeech,
  parseConfidence,
  extractCriticalSummary,
  looksLikeBackgroundMedia,
  conversationallyRelevant,
  getNoiseThresholds,
  twilioGatherSpeechAttrs,
  createMulawSpeechGate,
  getVoiceStackReport,
  SPEECH_ISOLATION_CAPABILITIES,
  PROMPTS,
} = require("../auraVoiceNoiseControl.cjs");

test("capabilities honestly deny caller voice lock on Gather", () => {
  assert.equal(SPEECH_ISOLATION_CAPABILITIES.callerVoiceLock, false);
  assert.equal(SPEECH_ISOLATION_CAPABILITIES.preTranscriptionDsp, false);
  assert.equal(SPEECH_ISOLATION_CAPABILITIES.gatherPathRawAudioAccess, false);
  const stack = getVoiceStackReport();
  assert.match(stack.noiseSuppression.gatherPreStt, /Not available/i);
});

test("stronger defaults raise barge-in above listen threshold", () => {
  const t = getNoiseThresholds(null);
  assert.ok(t.bargeInMinConfidence > t.minSpeechConfidence);
  assert.ok(t.bargeInMinConfidence >= 0.7);
});

test("short barge-in fragments are rejected", () => {
  const out = evaluateSpeechInput({
    callSid: "CA_frag",
    speechText: "hey",
    confidenceRaw: 0.95,
    isBargeInCandidate: true,
  });
  assert.equal(out.action, "reject_prompt");
  assert.match(out.reason, /bargein_too_short|irrelevant/);
});

test("low confidence critical cancel is blocked", () => {
  const out = evaluateSpeechInput({
    callSid: "CA_cancel",
    speechText: "please cancel my appointment",
    confidenceRaw: 0.4,
  });
  assert.equal(out.action, "reject_prompt");
  assert.equal(out.prompt, PROMPTS.repeat);
});

test("TV dialogue rejected", () => {
  assert.equal(looksLikeBackgroundMedia("Coming up next after the commercial break"), true);
  const out = evaluateSpeechInput({
    callSid: "CA_tv",
    speechText: "Coming up next after the commercial break",
    confidenceRaw: 0.9,
  });
  assert.equal(out.action, "reject_prompt");
});

test("relevant booking speech accepted at healthy confidence", () => {
  assert.equal(conversationallyRelevant("I need a fade tomorrow"), true);
  const out = evaluateSpeechInput({
    callSid: "CA_ok",
    speechText: "I need a fade tomorrow afternoon",
    confidenceRaw: 0.9,
  });
  assert.equal(out.action, "accept");
});

test("echo overlap still rejected", () => {
  rememberAssistantSpeech("CA_echo2", "Thank you for calling the IFCDC Barbers App. This is AURA.");
  const out = evaluateSpeechInput({
    callSid: "CA_echo2",
    speechText: "Thank you for calling the IFCDC Barbers App. This is AURA.",
    confidenceRaw: 0.95,
  });
  assert.equal(out.reason, "echo_overlap");
});

test("critical mid-confidence asks confirmation", () => {
  const out = evaluateSpeechInput({
    callSid: "CA_crit2",
    speechText: "Friday at 2:30 PM",
    confidenceRaw: 0.6,
  });
  assert.equal(out.action, "confirm_critical");
  assert.match(out.prompt, /I heard/i);
});

test("sustained mulaw barge-in requires multiple energetic frames", () => {
  const gate = createMulawSpeechGate();
  const loud = Buffer.alloc(160, 0x00).toString("base64");
  let forwarded = 0;
  for (let i = 0; i < 5; i++) {
    if (gate.shouldForward(loud, { assistantSpeaking: true })) forwarded += 1;
  }
  // First ~300ms should be held back
  assert.ok(forwarded < 5);
});

test("gather attrs use enhanced phone_call", () => {
  const g = twilioGatherSpeechAttrs("");
  assert.equal(g.enhanced, "true");
  assert.equal(g.speechModel, "phone_call");
});

test("parseConfidence and extractCriticalSummary still work", () => {
  assert.equal(parseConfidence(80), 0.8);
  assert.match(extractCriticalSummary("Friday at 2:30 PM haircut"), /friday/i);
});
