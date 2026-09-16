import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runSimpleBookingTurn, resetSimpleBookingState, STATES } from "../auraVoiceSimpleBookingFlow.js";

const require = createRequire(import.meta.url);
const {
  evaluateSpeechInput,
  rememberAssistantSpeech,
} = require("../auraVoiceNoiseControl.cjs");
const {
  beginCallerTurn,
  applyRepeatGuard,
  recordAuraTurn,
  markBargeIn,
  shouldResumeInterruptedResponse,
  mergeBookingInfo,
  snapshotLedger,
  setPendingQuestion,
  runExclusiveTurn,
  resetAllCallRuntime,
  semanticSimilarity,
  getReplay,
  rememberReplay,
} = require("../auraVoiceCallRuntime.cjs");

test.beforeEach(() => {
  resetAllCallRuntime();
});

test("unique turn id; duplicate transcript after replay is one primary response", () => {
  const a = beginCallerTurn("CA1", { speech: "I need a fade tomorrow", confidence: 0.9 });
  assert.equal(a.accepted, true);
  assert.ok(a.turnId);
  rememberReplay("CA1", { turnId: a.turnId, twiml: "<Response/>", reply: "What time?" });
  const b = beginCallerTurn("CA1", { speech: "I need a fade tomorrow", confidence: 0.9 });
  assert.equal(b.duplicate, true);
  assert.equal(b.turnId, a.turnId);
  assert.equal(b.replayTwiml, "<Response/>");
});

test("same fingerprint before replay is same in-flight turn, not a second generation", () => {
  const a = beginCallerTurn("CA2", { speech: "book a haircut", confidence: 0.88 });
  const b = beginCallerTurn("CA2", { speech: "book a haircut", confidence: 0.88 });
  assert.equal(b.sameTurn, true);
  assert.equal(b.turnId, a.turnId);
  assert.equal(b.duplicate, false);
});

test("exclusive turn coalesces concurrent generations", async () => {
  let runs = 0;
  const p1 = runExclusiveTurn("CA3", async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { n: runs };
  });
  const p2 = runExclusiveTurn("CA3", async () => {
    runs += 1;
    return { n: 99 };
  });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  assert.equal(runs, 1);
});

test("repeat guard is semantic, not exact-string only", () => {
  recordAuraTurn("CA4", { turnId: "t1", text: "What day works best for your fade?" });
  const exact = applyRepeatGuard("CA4", "What day works best for your fade?", { userText: "tomorrow" });
  assert.equal(exact.suppressed, true);
  const para = applyRepeatGuard("CA4", "Which day would work best for that fade?", { userText: "tomorrow" });
  assert.ok(para.similarity >= 0.5);
  const asked = applyRepeatGuard("CA4", "What day works best for your fade?", { userText: "please repeat that" });
  assert.equal(asked.suppressed, false);
});

test("semantic similarity scores paraphrases above noise", () => {
  const sim = semanticSimilarity(
    "Thank you for calling. How may I help you today?",
    "Thanks for calling. How can I help you today?",
  );
  assert.ok(sim >= 0.45);
  const low = semanticSimilarity("Friday at two", "I want a beard trim");
  assert.ok(low < 0.4);
});

test("in-call ledger keeps booking fields and pending question", () => {
  mergeBookingInfo("CA5", { service: "fade", day: "2026-09-14" });
  setPendingQuestion("CA5", "What time would you like?", "book");
  const snap = snapshotLedger("CA5");
  assert.equal(snap.booking.service, "fade");
  assert.equal(snap.booking.day, "2026-09-14");
  assert.equal(snap.pendingQuestions[0], "What time would you like?");
  assert.equal(snap.currentIntent, "book");
});

test("barge-in marks interrupted and never auto-resumes old response", () => {
  recordAuraTurn("CA6", { turnId: "old", text: "Let me tell you our long list of services..." });
  const b = markBargeIn("CA6", { turnId: "old" });
  assert.equal(b.resumeOldResponse, false);
  assert.equal(shouldResumeInterruptedResponse(), false);
  assert.equal(snapshotLedger("CA6").playbackInterrupted, true);
});

test("echo of own TTS is silent_listen", () => {
  rememberAssistantSpeech("CA7", "Hi, this is Aura. Thank you for calling the IFCDC Barbers App.");
  const out = evaluateSpeechInput({
    callSid: "CA7",
    speechText: "Hi, this is Aura. Thank you for calling the IFCDC Barbers App.",
    confidenceRaw: 0.95,
  });
  assert.equal(out.reason, "echo_overlap");
  assert.equal(out.action, "silent_listen");
});

test("hello after start does not reset booking to greeting", async () => {
  resetSimpleBookingState("CA8");
  const welcome = await runSimpleBookingTurn({
    callSid: "CA8",
    userInput: "__IFCDC_VOICE_WELCOME__",
    language: "en",
  });
  assert.equal(welcome.stage, STATES.SERVICE);
  const hello = await runSimpleBookingTurn({
    callSid: "CA8",
    userInput: "hello",
    language: "en",
  });
  assert.notEqual(hello.stage, STATES.START);
  assert.match(hello.bookingLog, /service_reprompt|service→day/);
  assert.doesNotMatch(String(hello.reply), /Thank you for calling the IFCDC Barbers App/i);
});

test("collected service survives a later no-speech turn", async () => {
  resetSimpleBookingState("CA9");
  await runSimpleBookingTurn({ callSid: "CA9", userInput: "__IFCDC_VOICE_WELCOME__", language: "en" });
  const svc = await runSimpleBookingTurn({ callSid: "CA9", userInput: "I need a fade", language: "en" });
  assert.equal(svc.stage, STATES.DAY);
  const later = await runSimpleBookingTurn({
    callSid: "CA9",
    userInput: "__IFCDC_NO_SPEECH__",
    language: "en",
  });
  assert.equal(later.stage, STATES.DAY);
  const snap = snapshotLedger("CA9");
  assert.match(String(snap.booking.service), /fade/i);
});

test("getReplay returns last TwiML for webhook retries", () => {
  rememberReplay("CA10", { turnId: "t", twiml: "<Response>ok</Response>", reply: "ok" });
  assert.equal(getReplay("CA10").twiml, "<Response>ok</Response>");
});
