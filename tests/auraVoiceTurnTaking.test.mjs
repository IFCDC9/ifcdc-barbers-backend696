import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSimpleAuraVoiceHandlers } from "../auraVoiceReply.js";
import {
  runSimpleBookingTurn,
  resetSimpleBookingState,
  STATES,
  extractSlots,
  parseTimeFromSpeech,
} from "../auraVoiceSimpleBookingFlow.js";

const require = createRequire(import.meta.url);
const {
  beginCallerTurn,
  rememberReplay,
  resetAllCallRuntime,
  hashTranscript,
  snapshotLedger,
  setCallLanguage,
  markBargeIn,
  shouldResumeInterruptedResponse,
  getTurn,
  getTurnTraces,
  isCallGreeted,
} = require("../auraVoiceCallRuntime.cjs");
const { createTurnDetector } = require("../auraPipecatPipeline.cjs");
const { isVoiceboxPrimary } = require("../auraVoiceboxFlags.cjs");

function mockRes() {
  const out = { body: "", type: "", headersSent: false };
  const res = {
    type(t) {
      out.type = t;
      return res;
    },
    set() {
      return res;
    },
    send(b) {
      out.body = String(b || "");
      out.headersSent = true;
      return res;
    },
    status() {
      return res;
    },
    json(b) {
      out.body = JSON.stringify(b);
      out.headersSent = true;
      return res;
    },
  };
  res._out = out;
  return res;
}

function mockReq(body, query = {}) {
  return { method: "POST", body, query, session: {} };
}

test.describe("aura turn taking", { concurrency: 1 }, () => {
test.beforeEach(() => {
  resetAllCallRuntime();
});

test("VOICEBOX_PRIMARY stays 0", () => {
  assert.equal(isVoiceboxPrimary(), false);
});

test("same transcript + different confidence is one turn (hash ignores confidence)", () => {
  const a = beginCallerTurn("CA-hash", { speech: "haircut tomorrow", confidence: 0.91, twilioEventId: "RQ1" });
  const b = beginCallerTurn("CA-hash", { speech: "haircut tomorrow", confidence: 0.77, twilioEventId: "RQ2" });
  assert.equal(a.transcriptHash, hashTranscript({ speech: "haircut tomorrow" }));
  assert.equal(b.turnId, a.turnId);
  assert.equal(b.sameTurn || b.duplicate, true);
});

test("duplicate Gather retry does not replay previous turn Play", () => {
  const greet = beginCallerTurn("CA-dup", {
    speech: "__IFCDC_VOICE_WELCOME__",
    twilioEventId: "RQ-start",
  });
  rememberReplay("CA-dup", {
    turnId: greet.turnId,
    twiml: "<Response><Play>https://example.test/GREETING.wav</Play></Response>",
    reply: "Hi, this is Aura. How can I help you today?",
    audioId: "aud_greet",
  });
  const first = beginCallerTurn("CA-dup", {
    speech: "I need a haircut tomorrow",
    confidence: 0.9,
    twilioEventId: "RQ-a",
  });
  assert.equal(first.accepted, true);
  assert.equal(first.replayTwiml, "");
  const retry = beginCallerTurn("CA-dup", {
    speech: "I need a haircut tomorrow",
    confidence: 0.88,
    twilioEventId: "RQ-a-retry",
  });
  assert.equal(retry.turnId, first.turnId);
  assert.doesNotMatch(String(retry.replayTwiml || ""), /GREETING\.wav/);
  assert.equal(retry.sameTurn, true);
  rememberReplay("CA-dup", {
    turnId: first.turnId,
    twiml: "<Response><Play>https://example.test/TURN2.wav</Play></Response>",
    reply: "What time?",
    audioId: "aud_t2",
  });
  const retry2 = beginCallerTurn("CA-dup", {
    speech: "I need a haircut tomorrow",
    twilioEventId: "RQ-a-retry-2",
  });
  assert.equal(retry2.duplicate, true);
  assert.match(retry2.replayTwiml, /TURN2\.wav/);
  assert.doesNotMatch(retry2.replayTwiml, /GREETING\.wav/);
  assert.notEqual(getTurn("CA-dup", greet.turnId).audioId, getTurn("CA-dup", first.turnId).audioId);
});

test("RequestSid is idempotent", () => {
  const a = beginCallerTurn("CA-rq", { speech: "fade please", twilioEventId: "RQ-same" });
  rememberReplay("CA-rq", { turnId: a.turnId, twiml: "<Response>once</Response>", reply: "What day?", audioId: "aud1" });
  const b = beginCallerTurn("CA-rq", { speech: "fade please", twilioEventId: "RQ-same" });
  assert.equal(b.duplicate, true);
  assert.equal(b.turnId, a.turnId);
  assert.equal(b.replayTwiml, "<Response>once</Response>");
});

test("interim UnstableSpeechResult is not a turn", () => {
  const a = beginCallerTurn("CA-int", {
    speech: "",
    unstable: "hai",
    transcriptFinal: false,
    twilioEventId: "RQ-u",
  });
  assert.equal(a.accepted, false);
  assert.equal(a.interim, true);
  assert.equal(a.reason, "interim_not_a_turn");
});

test("haircut tomorrow then around 2 stays in the slot machine", async () => {
  resetSimpleBookingState("CA-slots");
  const welcome = await runSimpleBookingTurn({
    callSid: "CA-slots",
    userInput: "__IFCDC_VOICE_WELCOME__",
    language: "en",
  });
  assert.match(welcome.reply, /Hi, this is Aura/i);
  assert.equal(isCallGreeted("CA-slots"), true);
  const t1 = await runSimpleBookingTurn({
    callSid: "CA-slots",
    userInput: "haircut tomorrow",
    language: "en",
  });
  assert.equal(t1.stage, STATES.TIME);
  const snap1 = snapshotLedger("CA-slots");
  assert.equal(snap1.booking.service, "Haircut");
  assert.match(String(snap1.booking.day), /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(t1.reply, /Hi, this is Aura/i);
  const t2 = await runSimpleBookingTurn({
    callSid: "CA-slots",
    userInput: "around 2",
    language: "en",
  });
  assert.equal(t2.stage, STATES.NAME);
  const snap2 = snapshotLedger("CA-slots");
  assert.equal(snap2.booking.service, "Haircut");
  assert.equal(snap2.booking.day, snap1.booking.day);
  assert.equal(snap2.booking.time, "14:00");
  assert.match(t2.reply, /name/i);
});

test("extractSlots reads service+day+time from one utterance", () => {
  const slots = extractSlots("haircut tomorrow around 2");
  assert.equal(slots.service, "Haircut");
  assert.match(slots.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(slots.time, "14:00");
  assert.equal(parseTimeFromSpeech("2pm"), "14:00");
  assert.equal(parseTimeFromSpeech("around two"), "14:00");
});

test("language switch preserves booking ledger", async () => {
  resetSimpleBookingState("CA-lang");
  await runSimpleBookingTurn({ callSid: "CA-lang", userInput: "__IFCDC_VOICE_WELCOME__", language: "en" });
  await runSimpleBookingTurn({ callSid: "CA-lang", userInput: "haircut tomorrow", language: "en" });
  setCallLanguage("CA-lang", "es");
  const snap = snapshotLedger("CA-lang");
  assert.equal(snap.language, "es");
  assert.equal(snap.booking.service, "Haircut");
  assert.match(String(snap.booking.day), /^\d{4}-\d{2}-\d{2}$/);
});

test("barge-in does not resume interrupted TTS", () => {
  const t = beginCallerTurn("CA-barge", { speech: "hello there friends", twilioEventId: "RQ-b1" });
  rememberReplay("CA-barge", {
    turnId: t.turnId,
    twiml: "<Response><Play>old.wav</Play></Response>",
    reply: "long list",
    audioId: "old",
  });
  const b = markBargeIn("CA-barge", { turnId: t.turnId });
  assert.equal(b.resumeOldResponse, false);
  assert.equal(shouldResumeInterruptedResponse(), false);
  const retry = beginCallerTurn("CA-barge", { speech: "hello there friends", twilioEventId: "RQ-b1" });
  assert.equal(retry.replayTwiml, "");
});

test("Pipecat VAD barge-in is rising-edge only", () => {
  const det = createTurnDetector({ silenceMs: 50, bargeInRms: 0.1 });
  const loud = Array(48).fill(1);
  assert.equal(det.pushPcm16(loud, 1000).bargeIn, true);
  assert.equal(det.pushPcm16(loud, 1010).bargeIn, false);
  assert.equal(det.pushPcm16(loud, 1020).bargeIn, false);
});

test("Twilio webhook sim: duplicate Gather callbacks yield one Aura TwiML", async () => {
  const { voice, process } = createSimpleAuraVoiceHandlers({});
  const sid = "CA-web";
  const v1 = mockRes();
  await voice(mockReq({ CallSid: sid, RequestSid: "RQ0" }), v1);
  assert.match(v1._out.body, /Redirect/);
  const p1 = mockRes();
  await process(mockReq({ CallSid: sid, RequestSid: "RQ0p" }), p1);
  assert.match(p1._out.body, /Hi, this is Aura/i);
  assert.doesNotMatch(p1._out.body, /Thank you for calling the IFCDC Barbers App/i);

  const body = {
    CallSid: sid,
    RequestSid: "RQ-g1",
    SpeechResult: "haircut tomorrow",
    Confidence: "0.92",
  };
  const v2 = mockRes();
  await voice(mockReq(body), v2);
  const p2 = mockRes();
  await process(mockReq({ CallSid: sid, RequestSid: "RQ-g1p" }), p2);
  const firstXml = p2._out.body;
  assert.match(firstXml, /time/i);
  assert.doesNotMatch(firstXml, /Hi, this is Aura/i);

  const v3 = mockRes();
  await voice(mockReq({ ...body, RequestSid: "RQ-g1-retry", Confidence: "0.81" }), v3);
  const p3 = mockRes();
  await process(mockReq({ CallSid: sid, RequestSid: "RQ-g1p-retry" }), p3);
  assert.equal(p3._out.body, firstXml);

  const v4 = mockRes();
  await voice(
    mockReq({
      CallSid: sid,
      RequestSid: "RQ-g2",
      SpeechResult: "around 2",
      Confidence: "0.9",
    }),
    v4,
  );
  const p4 = mockRes();
  await process(mockReq({ CallSid: sid, RequestSid: "RQ-g2p" }), p4);
  assert.match(p4._out.body, /name/i);
  assert.doesNotMatch(p4._out.body, /Hi, this is Aura/i);
  const snap = snapshotLedger(sid);
  assert.equal(snap.booking.service, "Haircut");
  assert.equal(snap.booking.time, "14:00");
  const traces = getTurnTraces(sid);
  assert.ok(traces.length >= 2);
  assert.ok(traces.every((row) => row.CALL_SESSION_ID === sid));
  assert.ok(traces.every((row) => !JSON.stringify(row).includes("hmac")));
});
});
