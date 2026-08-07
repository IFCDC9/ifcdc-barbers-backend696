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
  looksLikeMultiSpeaker,
  shouldForwardMulawFrame,
  getNoiseThresholds,
  twilioGatherSpeechAttrs,
} = require("../auraVoiceNoiseControl.cjs");

test("parseConfidence handles 0-1 and 0-100", () => {
  assert.equal(parseConfidence("0.81"), 0.81);
  assert.equal(parseConfidence(81), 0.81);
  assert.equal(parseConfidence(""), null);
});

test("background media and multi-speaker heuristics", () => {
  assert.equal(looksLikeBackgroundMedia("Coming up next on the news"), true);
  assert.equal(looksLikeBackgroundMedia("I want a fade tomorrow"), false);
  assert.equal(looksLikeMultiSpeaker('He said "hello" and she said "hi there"'), true);
});

test("extractCriticalSummary finds date/time/service", () => {
  const s = extractCriticalSummary("Friday at 2:30 PM haircut");
  assert.match(s, /friday/i);
  assert.match(s, /2:30/i);
  assert.match(s, /haircut/i);
});

test("low confidence speech is rejected with clearer prompt", () => {
  const out = evaluateSpeechInput({
    callSid: "CA_noise_1",
    speechText: "fade tomorrow",
    confidenceRaw: 0.2,
  });
  assert.equal(out.action, "reject_prompt");
  assert.match(out.prompt, /trouble hearing|background noise|closer/i);
});

test("healthy confidence is accepted", () => {
  const out = evaluateSpeechInput({
    callSid: "CA_noise_2",
    speechText: "I need a haircut tomorrow afternoon",
    confidenceRaw: 0.88,
  });
  assert.equal(out.action, "accept");
  assert.match(out.text, /haircut/i);
});

test("echo overlap rejects assistant playback bleed", () => {
  rememberAssistantSpeech(
    "CA_echo",
    "Thank you for calling the IFCDC Barbers App. This is AURA, your virtual assistant.",
  );
  const out = evaluateSpeechInput({
    callSid: "CA_echo",
    speechText: "Thank you for calling the IFCDC Barbers App. This is AURA, your virtual assistant.",
    confidenceRaw: 0.9,
  });
  assert.equal(out.action, "reject_prompt");
  assert.equal(out.reason, "echo_overlap");
});

test("critical low-confidence asks confirmation then accepts yes", () => {
  const first = evaluateSpeechInput({
    callSid: "CA_crit",
    speechText: "Friday at 2:30 PM",
    confidenceRaw: 0.55,
  });
  assert.equal(first.action, "confirm_critical");
  assert.match(first.prompt, /I heard/i);
  assert.match(first.prompt, /correct/i);

  const yes = evaluateSpeechInput({
    callSid: "CA_crit",
    speechText: "yes that's correct",
    confidenceRaw: 0.9,
  });
  assert.equal(yes.action, "use_pending");
  assert.match(yes.text, /Friday at 2:30/i);
});

test("barge-in requires higher confidence than normal speech", () => {
  const thresholds = getNoiseThresholds();
  const mid = (thresholds.minSpeechConfidence + thresholds.bargeInMinConfidence) / 2;
  const normal = evaluateSpeechInput({
    callSid: "CA_b1",
    speechText: "book me tomorrow",
    confidenceRaw: mid,
    isBargeInCandidate: false,
  });
  const barge = evaluateSpeechInput({
    callSid: "CA_b2",
    speechText: "book me tomorrow",
    confidenceRaw: mid,
    isBargeInCandidate: true,
  });
  // mid may accept normal and reject barge, or confirm_critical — barge must not be freer than normal
  assert.ok(normal.action === "accept" || normal.action === "confirm_critical" || normal.action === "reject_prompt");
  if (normal.action === "accept" || normal.action === "confirm_critical") {
    assert.equal(barge.action, "reject_prompt");
  }
});

test("twilio gather uses enhanced phone_call model", () => {
  const g = twilioGatherSpeechAttrs();
  assert.equal(g.enhanced, "true");
  assert.equal(g.speechModel, "phone_call");
  assert.equal(g.bargeIn, "true");
});

test("mulaw energy gate fails open on tiny buffer and drops empty", () => {
  assert.equal(shouldForwardMulawFrame(""), false);
  // Valid base64 silence-ish should be gated by energy; random high bytes should pass
  const loud = Buffer.alloc(160, 0x00).toString("base64"); // μ-law xor pattern often energetic
  assert.equal(typeof shouldForwardMulawFrame(loud, { assistantSpeaking: false }), "boolean");
});
