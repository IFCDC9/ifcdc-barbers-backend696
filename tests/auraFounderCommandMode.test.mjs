import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("founder identity phone is never the public AURA line", () => {
  const {
    FOUNDER_VERIFIED_PHONE_E164,
    founderPhoneE164,
    isFounderCaller,
  } = require("../auraFounderIdentity.cjs");
  const { getOfficialAuraBusinessE164 } = require("../auraVoiceIntelligenceFlags.cjs");
  assert.equal(FOUNDER_VERIFIED_PHONE_E164, "+18484694448");
  assert.equal(founderPhoneE164(), "+18484694448");
  assert.notEqual(founderPhoneE164(), getOfficialAuraBusinessE164());
  assert.equal(isFounderCaller("+18484694448"), true);
  assert.equal(isFounderCaller("+19895141064"), false);
  assert.equal(isFounderCaller("+15551234567"), false);
});

test("founder greeting text is exact operational welcome", () => {
  const { FOUNDER_GREETING } = require("../auraFounderIdentity.cjs");
  assert.match(FOUNDER_GREETING, /Welcome back, Mister Allah/);
  assert.match(FOUNDER_GREETING, /operational updates ready/i);
  assert.match(FOUNDER_GREETING, /How may I assist you today/i);
  assert.doesNotMatch(FOUNDER_GREETING, /^(Hello\?|Hi\.|What do you need\?)/i);
});

test("founder command detection covers schedule and change queries", () => {
  const { detectFounderCommand } = require("../auraFounderCommands.cjs");
  assert.equal(detectFounderCommand("Give me today's full schedule.").cmd, "today_schedule");
  assert.equal(detectFounderCommand("What changed since my last call?").cmd, "changes_since_last_call");
  assert.equal(detectFounderCommand("Who booked today?").cmd, "who_booked_today");
  assert.equal(detectFounderCommand("Did anyone cancel?").cmd, "cancellations_today");
  assert.equal(detectFounderCommand("What payments are still pending?").cmd, "payments_pending");
  assert.equal(detectFounderCommand("Book a customer for me.").cmd, "book_for_me");
  assert.equal(detectFounderCommand("Book a customer for me.").protected, true);
  assert.equal(detectFounderCommand("hello there").cmd, null);
});

test("PIN is never accepted from empty env", () => {
  delete process.env.AURA_OWNER_VOICE_PIN;
  const { founderPinConfigured, founderPinMatches } = require("../auraFounderIdentity.cjs");
  assert.equal(founderPinConfigured(), false);
  assert.equal(founderPinMatches("1234"), false);
  process.env.AURA_OWNER_VOICE_PIN = "48291";
  assert.equal(founderPinConfigured(), true);
  assert.equal(founderPinMatches("48291"), true);
  assert.equal(founderPinMatches("0000"), false);
  delete process.env.AURA_OWNER_VOICE_PIN;
});

test("google calendar reports disconnected by default", () => {
  delete process.env.GOOGLE_CALENDAR_CONNECTED;
  delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  const { googleCalendarStatus } = require("../auraFounderBriefing.cjs");
  const st = googleCalendarStatus();
  assert.equal(st.connected, false);
  assert.match(st.spokenUnavailable, /personal calendar is not connected/i);
  assert.deepEqual(st.events, []);
});

test("founder greeting on verified CLI when Phase 1 on", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_founder_${Date.now()}`;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+18484694448",
    userInput: "__IFCDC_VOICE_WELCOME__",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Mister Allah/i);
  assert.match(out.reply, /operational updates ready|How may I assist you today/i);
  getSession(sid).greeted = true;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("unknown caller cannot enter founder-only commands", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_stranger_${Date.now()}`;
  getSession(sid).greeted = true;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+15559876543",
    userInput: "What changed since my last call?",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /Founder Command Mode is only available/i);
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("incorrect founder PIN remains locked", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  process.env.AURA_OWNER_VOICE_PIN = "9999";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_pin_bad_${Date.now()}`;
  getSession(sid).greeted = true;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+18484694448",
    userInput: "1111",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /not accepted/i);
  assert.equal(getSession(sid).ownerPinOk, false);
  delete process.env.AURA_OWNER_VOICE_PIN;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("correct founder PIN unlocks protected actions", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  process.env.AURA_OWNER_VOICE_PIN = "2468";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_pin_ok_${Date.now()}`;
  getSession(sid).greeted = true;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+18484694448",
    userInput: "2468",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /PIN verified/i);
  assert.equal(getSession(sid).ownerPinOk, true);
  delete process.env.AURA_OWNER_VOICE_PIN;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("protected cancel without PIN is denied", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  process.env.AURA_OWNER_VOICE_PIN = "2468";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_cancel_gate_${Date.now()}`;
  getSession(sid).greeted = true;
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+18484694448",
    userInput: "Cancel that appointment for John",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /PIN/i);
  assert.equal(getSession(sid).ownerPinOk, false);
  delete process.env.AURA_OWNER_VOICE_PIN;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});
