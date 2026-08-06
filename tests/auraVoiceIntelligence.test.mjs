import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("Voice Intelligence Phase 1 flag defaults off", () => {
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
  const { isAuraVoiceIntelligencePhase1, auraVoiceIntelligenceFlags } = require("../auraVoiceIntelligenceFlags.cjs");
  assert.equal(isAuraVoiceIntelligencePhase1(), false);
  assert.equal(auraVoiceIntelligenceFlags().phase1Enabled, false);
});

test("Voice Intelligence Phase 1 flag accepts true", () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "true";
  // Re-require won't reload — call envOn via fresh evaluation by reading module exports that read env each call
  const { isAuraVoiceIntelligencePhase1 } = require("../auraVoiceIntelligenceFlags.cjs");
  assert.equal(isAuraVoiceIntelligencePhase1(), true);
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("intent detection covers booking, cancel, human, prices", () => {
  const { detectCallerIntents } = require("../auraVoiceIntelligenceIntents.cjs");
  assert.equal(detectCallerIntents("I'd like to book an appointment").primary, "book_appointment");
  assert.equal(detectCallerIntents("please cancel my appointment").primary, "cancel_appointment");
  assert.equal(detectCallerIntents("I need to speak to a human").primary, "request_human");
  assert.equal(detectCallerIntents("how much does a fade cost").primary, "ask_prices");
  assert.equal(detectCallerIntents("book and also what are your hours").multi, true);
});

test("payment card risk blocks PAN-like input", () => {
  const { detectPaymentCardRisk } = require("../auraVoiceIntelligenceIntents.cjs");
  const blocked = detectPaymentCardRisk("my card is 4111111111111111");
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reply, /never collect card/i);
  assert.equal(detectPaymentCardRisk("can you send a payment link").blocked, false);
});

test("owner caller recognition for +18484694448", () => {
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  const { isOwnerCaller } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  assert.equal(isOwnerCaller("+18484694448"), true);
  assert.equal(isOwnerCaller("8484694448"), true);
  assert.equal(isOwnerCaller("+19895141064"), false);
});

test("orchestrator is inert when flag off", async () => {
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
  const { runVoiceIntelligenceTurn } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const out = await runVoiceIntelligenceTurn({
    callSid: "CA_test",
    from: "+15551234567",
    userInput: "book haircut",
  });
  assert.equal(out.handled, false);
  assert.equal(out.useLegacyBooking, true);
});

test("orchestrator owner greeting when flag on", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  // reset session
  const sid = `CA_owner_${Date.now()}`;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+18484694448",
    userInput: "__IFCDC_VOICE_WELCOME__",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Mister Allah/i);
  assert.match(out.reply, /I F C D C/);
  getSession(sid).greeted = true;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("booking confirm requires backend success before claiming confirmed", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_book_${Date.now()}`;
  const sess = getSession(sid);
  sess.greeted = true;
  sess.bookingStep = "confirm";
  sess.bookingDraft = {
    name: "Test User",
    service: "Haircut",
    barber: "first available",
    dateYmd: "2026-08-10",
    time: "14:00",
    phone: "+15551234567",
  };
  const fail = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+15551234567",
    userInput: "yes",
    insertVoiceRow: async () => ({ ok: false, error: "slot_unavailable" }),
  });
  assert.equal(fail.handled, true);
  assert.match(fail.reply, /will not say it is confirmed|did not complete/i);
  assert.equal(fail.afterBookingClose, undefined);

  sess.bookingStep = "confirm";
  const ok = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+15551234567",
    userInput: "yes",
    insertVoiceRow: async () => ({ ok: true, bookingId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
  });
  assert.equal(ok.handled, true);
  assert.equal(ok.afterBookingClose, true);
  assert.match(ok.reply, /confirmed|Confirmation/i);
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("human request creates escalation path language", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_human_${Date.now()}`;
  getSession(sid).greeted = true;
  const inserts = [];
  const dbQuery = async (sql, params) => {
    inserts.push({ sql: String(sql).slice(0, 80), params });
    return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
  };
  const out = await runVoiceIntelligenceTurn({
    dbQuery,
    callSid: sid,
    from: "+15559876543",
    userInput: "I want to speak to a real person please",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /support summary|team member/i);
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});
