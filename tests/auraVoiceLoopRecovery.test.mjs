import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runSimpleBookingTurn } from "../auraVoiceSimpleBookingFlow.js";
import { createSimpleAuraVoiceHandlers, generateAuraReply } from "../auraVoiceReply.js";
import { isPhoneConversationQuestion, phoneQuestionFallback } from "../auraVoiceConversation.js";
const require = createRequire(import.meta.url);
const { beginCallerTurn, rememberReplay, recordAuraTurn, applyRepeatGuard,
  setPendingQuestion, snapshotLedger, resetAllCallRuntime } = require("../auraVoiceCallRuntime.cjs");

test.beforeEach(() => resetAllCallRuntime());

test("repeated booking tool questions and corrected confirmations survive similarity guard", () => {
  for (const text of ["What day works best?", "Please say yes to confirm or no to change."]) {
    recordAuraTurn("repeat", { text });
    setPendingQuestion("repeat", text, "book");
    assert.equal(applyRepeatGuard("repeat", text, { authoritative: true }).reply, text);
    assert.doesNotMatch(applyRepeatGuard("repeat", text).reply, /already (?:have|noted)/i);
  }
});

test("same answer after an intervening question is a fresh turn, stable webhook retry still replays", () => {
  const first = beginCallerTurn("dedup", { speech: "yes", twilioEventId: "first" });
  rememberReplay("dedup", { turnId: first.turnId, twiml: "<Response>old</Response>" });
  beginCallerTurn("dedup", { speech: "Friday at two", twilioEventId: "correction" });
  const second = beginCallerTurn("dedup", { speech: "yes", twilioEventId: "second" });
  assert.equal(second.accepted, true);
  assert.notEqual(second.turnId, first.turnId);
  rememberReplay("dedup", { turnId: second.turnId, twiml: "<Response>new</Response>" });
  assert.equal(beginCallerTurn("dedup", { speech: "yes", twilioEventId: "second" }).replayTwiml, "<Response>new</Response>");
});

test("confirmation correction preserves name and service and requires a fresh yes before exactly one insert", async () => {
  const sid = "correction";
  let saves = 0;
  const turn = (userInput) => runSimpleBookingTurn({ callSid: sid, userInput, language: "en",
    insertVoiceRow: async () => { saves++; return { ok: true }; } });
  await turn("__IFCDC_VOICE_WELCOME__");
  await turn("haircut tomorrow at two");
  await turn("Fahreal Allah");
  const before = snapshotLedger(sid).booking;
  assert.equal((await turn("no")).bookingLog, "confirm_awaiting_correction");
  const changed = await turn("yes but Friday at three");
  assert.equal(changed.bookingLog, "confirm_corrected_requires_confirmation");
  assert.equal(saves, 0);
  const after = snapshotLedger(sid).booking;
  assert.equal(after.name, before.name);
  assert.equal(after.service, before.service);
  assert.equal(after.time, "15:00");
  assert.match(changed.reply, /Fahreal Allah/);
  assert.equal((await turn("yes")).afterBookingClose, true);
  await turn("yes");
  assert.equal(saves, 1);
});

test("qualified yes without a recognized correction cannot submit", async () => {
  let saves = 0;
  const turn = (userInput) => runSimpleBookingTurn({ callSid: "qualified", userInput,
    insertVoiceRow: async () => { saves++; return { ok: true }; } });
  await turn("haircut tomorrow at two");
  await turn("Fahreal Allah");
  await turn("yes but not that");
  assert.equal(saves, 0);
});

test("phone question routing distinguishes questions from names, slot answers and booking requests", () => {
  for (const input of ["What are your hours?", "How much does a fade cost?", "I already told you", "cancel my appointment"]) {
    assert.equal(isPhoneConversationQuestion(input), true, input);
  }
  for (const input of ["Fahreal Allah", "Tomorrow afternoon", "yes", "Actually Friday at three", "Can you book a haircut tomorrow?"]) {
    assert.equal(isPhoneConversationQuestion(input), false, input);
  }
  assert.match(phoneQuestionFallback("cancel my appointment"), /have not changed/i);
});

test("phone conversational reply carries history and ledger, forbids invented facts/actions and omits repeated menu", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "Please check the shop's current hours in the app." } }] }) };
  };
  try {
    recordAuraTurn("question", { text: "What day works best?" });
    const reply = await generateAuraReply("What are your hours?", { callSid: "question", language: "en" });
    assert.match(payload.messages[0].content, /Do not invent shop hours/);
    assert.match(payload.messages[0].content, /no action tools/);
    assert.ok(payload.messages.some((m) => m.role === "assistant" && /What day/.test(m.content)));
    assert.match(payload.messages.at(-1).content, /In-call ledger/);
    assert.doesNotMatch(reply, /You can say book|already have/i);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("actual phone process answers a side question without consuming or losing booking details", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldPhase = process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
  process.env.OPENAI_API_KEY = "test-only";
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "Check the shop's hours in the app. What time would you like?" } }] }) });
  try {
    const sid = "handler-question";
    await runSimpleBookingTurn({ callSid: sid, userInput: "haircut tomorrow" });
    const before = snapshotLedger(sid).booking;
    const { process: processTurn } = createSimpleAuraVoiceHandlers({});
    const res = { body: "", type() { return this; }, set() { return this; }, status() { return this; },
      send(xml) { this.body = String(xml); this.headersSent = true; return this; } };
    await processTurn({ method: "POST", session: {}, query: {}, body: { CallSid: sid, RequestSid: "question-request", SpeechResult: "What are your hours?", Confidence: "0.99" } }, res);
    assert.match(res.body, /shop.*hours/i);
    assert.deepEqual(snapshotLedger(sid).booking, before);
    assert.doesNotMatch(res.body, /already have that/i);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldPhase === undefined) delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1; else process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = oldPhase;
  }
});

test("missing provider configuration uses a conservative phone answer instead of a booking menu", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const reply = await generateAuraReply("What are your hours?", { callSid: "no-provider" });
    assert.match(reply, /can't verify/);
    assert.doesNotMatch(reply, /You can say book|already have|open at/i);
  } finally {
    if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey;
  }
});
