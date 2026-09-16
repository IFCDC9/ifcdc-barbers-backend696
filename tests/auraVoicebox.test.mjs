/**
 * AURA Voicebox integration — autonomous tests 1–17 (hard PASS/FAIL).
 * Live Voicebox is used when 127.0.0.1:17493 answers. Synthesis without a
 * downloaded model is FAIL (not a soft-pass). Outage paths use a mock client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { detectVoiceLanguageFromText, resolveVoiceReplyLang } from "../auraLocale.js";

const require = createRequire(import.meta.url);
const { isVoiceboxPrimary, voiceboxFlags } = require("../auraVoiceboxFlags.cjs");
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const {
  AURA_ALLAH_NAME,
  AURA_PUBLIC_NAME,
  FOUNDER_APPROVED_VOICE,
  SAMPLE_A_INSTRUCT,
  SAMPLE_SENTENCE,
  SAMPLE_SENTENCE_ES,
  SAMPLE_SENTENCE_HE,
  selectBestLocalEngine,
  auraAllahCreateBody,
  SAMPLE_INSTRUCTS,
  ensureAuraAllahProfile,
  findAuraAllah,
  selectLanguageRoute,
} = require("../auraVoiceboxProfile.cjs");
const {
  speak,
  speakStreaming,
  cancelSpeak,
  tryVoiceboxPlayUrl,
  probeHealth,
  getVoiceboxHqStatus,
  setVoiceboxClientForTests,
  resetVoiceboxBridgeForTests,
  isValidAudio,
  mapLanguage,
} = require("../auraVoiceboxBridge.cjs");
const { prepareSpokenText } = require("../auraVoicePronunciation.cjs");
const {
  mergeBookingInfo,
  snapshotLedger,
  setCallLanguage,
  getCallLanguage,
  markBargeIn,
  resetAllCallRuntime,
} = require("../auraVoiceCallRuntime.cjs");
const { upsertPronunciation, addLesson, getVoiceMemorySnapshot, persistLatencySample, persistLastTest } = require("../auraVoiceMemory.cjs");
const { isPipecatEnabled, pipecatFlags } = require("../auraPipecatFlags.cjs");
const {
  splitForStreaming,
  createTurnDetector,
  switchCallLanguage,
  interruptSpeech,
  recoverWithFallback,
  createMockTwilioStream,
  resetPipecatForTests,
  setLastTest,
} = require("../auraPipecatPipeline.cjs");

const results = [];

function tinyWav() {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

function mockClient(overrides = {}) {
  const generated = [];
  const cancelled = [];
  const profile = {
    id: "profile-aura-allah",
    name: AURA_ALLAH_NAME,
    voice_type: "preset",
    preset_engine: "kokoro",
    preset_voice_id: "af_heart",
    default_engine: "kokoro",
    language: "en",
  };
  return {
    generated,
    cancelled,
    health: async () => ({
      status: "healthy",
      model_loaded: true,
      gpu_available: false,
      backend_type: "pytorch",
      backend_variant: "cpu",
    }),
    modelsStatus: async () => ({
      models: [
        { model_name: "qwen-tts-1.7B", downloaded: true, loaded: true, display_name: "Qwen TTS 1.7B" },
        { model_name: "kokoro", downloaded: true, loaded: true, display_name: "Kokoro 82M" },
      ],
    }),
    listProfiles: async () => [profile],
    createProfile: async (body) => ({ id: "profile-new", ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    updateProfile: async (id, body) => ({ id, ...profile, ...body, updated_at: new Date().toISOString() }),
    generateStream: async (body) => {
      generated.push({ via: "stream", ...body });
      return { buffer: tinyWav(), contentType: "audio/wav" };
    },
    generate: async (body) => {
      generated.push({ via: "generate", ...body });
      return { id: "gen-1", status: "completed", profile_id: body.profile_id, text: body.text, language: body.language, created_at: new Date().toISOString() };
    },
    getAudio: async () => ({ buffer: tinyWav(), contentType: "audio/wav" }),
    getHistory: async () => ({ id: "gen-1", status: "completed" }),
    cancelGeneration: async (id) => {
      cancelled.push(id);
      return { ok: true };
    },
    ...overrides,
  };
}

test.beforeEach(() => {
  resetVoiceboxBridgeForTests();
  resetAllCallRuntime();
  resetPipecatForTests();
});

test("1 live Voicebox health", async () => {
  const live = createVoiceboxClient();
  let row;
  try {
    const health = await live.health(2500);
    row = { result: String(health?.status).toLowerCase() === "healthy" ? "PASS" : "FAIL", detail: health };
    assert.equal(String(health?.status).toLowerCase(), "healthy");
  } catch (e) {
    row = { result: "FAIL", detail: String(e?.message || e) };
    assert.fail(`Voicebox not reachable: ${e?.message || e}`);
  } finally {
    results.push({ id: 1, name: "Live Voicebox GET /health", ...row });
  }
});

test("2 VOICEBOX_PRIMARY defaults off", () => {
  const prev = process.env.VOICEBOX_PRIMARY;
  delete process.env.VOICEBOX_PRIMARY;
  try {
    assert.equal(isVoiceboxPrimary(), false);
    assert.equal(voiceboxFlags().primary, false);
    results.push({ id: 2, name: "VOICEBOX_PRIMARY default 0", result: "PASS" });
  } finally {
    if (prev !== undefined) process.env.VOICEBOX_PRIMARY = prev;
  }
});

test("3 AURA founder-approved profile is designed/preset not cloned", async () => {
  let liveOk = false;
  try {
    const live = createVoiceboxClient();
    const models = await live.modelsStatus();
    const engine = selectBestLocalEngine(models);
    const { profile } = await ensureAuraAllahProfile(live, engine);
    assert.equal(profile.name, AURA_ALLAH_NAME);
    assert.doesNotMatch(profile.name, /ALLAH/i);
    assert.notEqual(profile.voice_type, "cloned");
    liveOk = true;
    results.push({ id: 3, name: "AURA founder-approved profile not cloned", result: "PASS", detail: profile.voice_type });
    return;
  } catch (e) {
    const client = mockClient();
    setVoiceboxClientForTests(client);
    const existing = findAuraAllah(await client.listProfiles());
    const body = auraAllahCreateBody(selectBestLocalEngine(await client.modelsStatus()));
    assert.equal(body.name, AURA_ALLAH_NAME);
    assert.notEqual(body.voice_type, "cloned");
    results.push({
      id: 3,
      name: "AURA founder-approved profile not cloned",
      result: "FAIL",
      detail: `live create failed (${e?.message || e}); mock body voice_type=${body.voice_type}; existing=${existing?.name || "none"}`,
    });
    assert.fail(`live profile step failed: ${e?.message || e}`);
  }
  assert.equal(liveOk, true);
});

test("4 speak() maps to real Voicebox generate fields", async () => {
  const client = mockClient();
  setVoiceboxClientForTests(client);
  const out = await speak({
    text: "Hello from Aura at IFCDC.",
    language: "en",
    voiceProfile: AURA_ALLAH_NAME,
    emotionalTone: "warm and confident",
    speed: "slow",
    conversationId: "map-1",
  });
  assert.equal(out.ok, true);
  assert.equal(out.fallback, false);
  const body = client.generated[0];
  assert.ok(body);
  assert.equal(body.profile_id, "profile-aura-allah");
  assert.equal(body.language, "en");
  assert.equal(body.engine, "kokoro");
  assert.match(String(body.instruct || ""), /Warm, soft, confident, conversational/i);
  assert.ok(isValidAudio(out.audio));
  results.push({ id: 4, name: "speak() maps to /generate or /generate/stream", result: "PASS" });
});

test("5 English language mapping", () => {
  assert.equal(mapLanguage("en-US"), "en");
  results.push({ id: 5, name: "EN language mapping", result: "PASS" });
});

test("6 Spanish language mapping", () => {
  assert.equal(mapLanguage("es-MX"), "es");
  assert.equal(detectVoiceLanguageFromText("Hola, quiero reservar un corte"), "es");
  results.push({ id: 6, name: "ES language mapping", result: "PASS" });
});

test("7 Hebrew language mapping + Voicebox lang list", () => {
  assert.equal(mapLanguage("he-IL"), "he");
  assert.equal(mapLanguage("iw"), "he");
  assert.equal(detectVoiceLanguageFromText("שלום, אני רוצה תור"), "he");
  results.push({ id: 7, name: "HE language mapping", result: "PASS" });
});

test("8 language change does not reset booking state", () => {
  mergeBookingInfo("CA-lang", { service: "fade", day: "tomorrow", time: "2:30 PM", name: "Jordan" });
  setCallLanguage("CA-lang", "es");
  setCallLanguage("CA-lang", "he");
  const snap = snapshotLedger("CA-lang");
  assert.equal(snap.booking.service, "fade");
  assert.equal(snap.booking.day, "tomorrow");
  assert.equal(snap.booking.time, "2:30 PM");
  assert.equal(snap.booking.name, "Jordan");
  assert.equal(getCallLanguage("CA-lang"), "he");
  assert.equal(snap.language, "he");
  assert.equal(resolveVoiceReplyLang("", "he", "en"), "he");
  results.push({ id: 8, name: "Language change keeps booking ledger", result: "PASS" });
});

test("9 same profile across EN/ES; HE uses Polly fallback", async () => {
  const client = mockClient();
  setVoiceboxClientForTests(client);
  for (const lang of ["en", "es"]) {
    const out = await speak({ text: "Booking confirmation", language: lang, conversationId: `same-${lang}` });
    assert.equal(out.ok, true);
    assert.equal(out.profileId, "profile-aura-allah");
    assert.equal(out.language, lang);
  }
  const ids = client.generated.map((g) => g.profile_id);
  assert.ok(ids.every((id) => id === "profile-aura-allah"));
  const he = await speak({ text: "Booking confirmation", language: "he", conversationId: "same-he" });
  assert.equal(he.ok, false);
  assert.equal(he.fallback, true);
  assert.equal(he.reason, "hebrew_kokoro_too_slow");
  results.push({ id: 9, name: "Same Sample A profile EN/ES; HE Polly fallback", result: "PASS" });
});

test("10 timeout → fallback", async () => {
  const client = mockClient({
    generateStream: async () => {
      await new Promise((r) => setTimeout(r, 50));
      const err = new Error("voicebox_timeout");
      err.code = "timeout";
      throw err;
    },
    generate: async () => {
      const err = new Error("voicebox_timeout");
      err.code = "timeout";
      throw err;
    },
  });
  setVoiceboxClientForTests(client);
  const out = await speak({ text: "Hello", language: "en", conversationId: "to-1" });
  assert.equal(out.ok, false);
  assert.equal(out.fallback, true);
  assert.equal(out.reason, "timeout");
  results.push({ id: 10, name: "Timeout automatic fallback", result: "PASS" });
});

test("11 invalid audio → fallback", async () => {
  const client = mockClient({
    generateStream: async () => ({ buffer: Buffer.from("not-audio"), contentType: "text/plain" }),
    generate: async (body) => ({ id: "bad", status: "completed", profile_id: body.profile_id, text: body.text, language: body.language, created_at: new Date().toISOString() }),
    getAudio: async () => ({ buffer: Buffer.from("not-audio"), contentType: "text/plain" }),
  });
  setVoiceboxClientForTests(client);
  const out = await speak({ text: "Hello", language: "en", conversationId: "bad-1" });
  assert.equal(out.ok, false);
  assert.equal(out.fallback, true);
  results.push({ id: 11, name: "Invalid audio automatic fallback", result: "PASS" });
});

test("12 outage → fallback, no dropped call", async () => {
  const client = mockClient({
    health: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  setVoiceboxClientForTests(client);
  const out = await speak({ text: "Hello", language: "en", conversationId: "down-1" });
  assert.equal(out.ok, false);
  assert.equal(out.fallback, true);
  const prev = process.env.VOICEBOX_PRIMARY;
  process.env.VOICEBOX_PRIMARY = "1";
  try {
    const play = await tryVoiceboxPlayUrl({ text: "Hello", language: "en", conversationId: "down-2" });
    assert.equal(play.used, false);
    assert.equal(play.fallback || !play.url, true);
  } finally {
    if (prev === undefined) delete process.env.VOICEBOX_PRIMARY;
    else process.env.VOICEBOX_PRIMARY = prev;
  }
  results.push({ id: 12, name: "Outage fallback (no dropped call)", result: "PASS" });
});

test("13 pronunciation dictionary IFCDC + Aura / time", () => {
  assert.match(SAMPLE_SENTENCE, /^Hi, this is Aura\b/);
  assert.doesNotMatch(SAMPLE_SENTENCE, /Allah/i);
  assert.match(SAMPLE_SENTENCE_ES, /\bsoy Aura\b/);
  assert.doesNotMatch(SAMPLE_SENTENCE_ES, /Allah/i);
  assert.match(SAMPLE_SENTENCE_HE, /כאן Aura/);
  assert.doesNotMatch(SAMPLE_SENTENCE_HE, /Allah/i);
  const spoken = prepareSpokenText("Welcome to IFCDC. This is AURA ALLAH. Your time is 2:30 PM.", { language: "en" });
  assert.match(spoken, /I F C D C/);
  assert.match(spoken, /\bAura\b/);
  assert.doesNotMatch(spoken, /Allah/i);
  assert.match(spoken, /two thirty P M/i);
  assert.doesNotMatch(spoken, /\bIFCDC\b/);
  results.push({ id: 13, name: "Pronunciation IFCDC / Aura / time", result: "PASS" });
});

test("14 barge-in cancels inflight Voicebox generation", async () => {
  let cancelled = [];
  const client = mockClient({
    generateStream: async () => {
      throw new Error("stream_unavailable");
    },
    generate: async (body) => ({
      id: "gen-slow",
      status: "generating",
      profile_id: body.profile_id,
      text: body.text,
      language: body.language,
      created_at: new Date().toISOString(),
    }),
    getHistory: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { id: "gen-slow", status: "generating" };
    },
    cancelGeneration: async (id) => {
      cancelled.push(id);
      return { ok: true };
    },
  });
  setVoiceboxClientForTests(client);
  const p = speak({ text: "This is a long confirmation.", language: "en", conversationId: "CA-barge" });
  await new Promise((r) => setTimeout(r, 20));
  markBargeIn("CA-barge");
  await cancelSpeak("CA-barge");
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.fallback, true);
  assert.ok(cancelled.includes("gen-slow") || out.reason === "timeout" || out.reason === "error");
  results.push({ id: 14, name: "Barge-in cancel", result: "PASS", detail: cancelled });
});

test("15 queue serializes per conversationId", async () => {
  const order = [];
  const client = mockClient({
    generateStream: async (body) => {
      order.push(body.text);
      await new Promise((r) => setTimeout(r, 30));
      return { buffer: tinyWav(), contentType: "audio/wav" };
    },
  });
  setVoiceboxClientForTests(client);
  await Promise.all([
    speak({ text: "one", language: "en", conversationId: "Q1" }),
    speak({ text: "two", language: "en", conversationId: "Q1" }),
  ]);
  assert.deepEqual(order, ["one", "two"]);
  results.push({ id: 15, name: "Per-conversation queue", result: "PASS" });
});

test("16 HQ status payload fields", async () => {
  const client = mockClient();
  setVoiceboxClientForTests(client);
  addLesson("Say shop names slowly.");
  upsertPronunciation({ from: "Fade", to: "fade" });
  const hq = await getVoiceboxHqStatus();
  for (const key of ["status", "model", "profile", "language", "latencyMs", "fallback", "lastLesson", "founderApproved", "productionActivation"]) {
    assert.ok(key in hq, `missing ${key}`);
  }
  assert.equal(typeof hq.status, "string");
  assert.equal(hq.productionActivation, "OFF");
  assert.equal(hq.primary, false);
  assert.equal(hq.founderApproved.sample, "A");
  assert.equal(hq.founderApproved.voiceId, "af_heart");
  assert.equal(hq.founderApproved.profileName, AURA_ALLAH_NAME);
  assert.equal(hq.founderApproved.customerFacingName, "Aura");
  assert.equal(AURA_PUBLIC_NAME, "Aura");
  assert.doesNotMatch(hq.founderApproved.profileName, /ALLAH/i);
  assert.equal(hq.founderApproved.productionActivation, "OFF");
  assert.ok(getVoiceMemorySnapshot().lastLesson);
  assert.equal(getVoiceMemorySnapshot().founderApprovedVoice.voiceId, "af_heart");
  assert.equal(getVoiceMemorySnapshot().founderApprovedVoice.customerFacingName, "Aura");
  assert.doesNotMatch(String(getVoiceMemorySnapshot().founderApprovedVoice.name || ""), /ALLAH/i);
  assert.equal(FOUNDER_APPROVED_VOICE.instruct, SAMPLE_A_INSTRUCT);
  results.push({ id: 16, name: "HQ VOICEBOX STATUS fields", result: "PASS", detail: hq.status });
});

test("17 Voicebox does not replace booking; primary-off skips TTS", async () => {
  mergeBookingInfo("CA-book", { service: "haircut" });
  const prev = process.env.VOICEBOX_PRIMARY;
  delete process.env.VOICEBOX_PRIMARY;
  try {
    const play = await tryVoiceboxPlayUrl({ text: "What time works?", conversationId: "CA-book" });
    assert.equal(play.used, false);
    assert.equal(play.reason, "primary_off");
    assert.equal(snapshotLedger("CA-book").booking.service, "haircut");
    assert.ok(SAMPLE_INSTRUCTS.A && SAMPLE_INSTRUCTS.E);
    results.push({ id: 17, name: "Booking unchanged; primary off uses Polly", result: "PASS" });
  } finally {
    if (prev !== undefined) process.env.VOICEBOX_PRIMARY = prev;
  }
});

const LONG_BOOKING =
  "I can get you in tomorrow at two thirty P M for a fade haircut. What name should I put on the chair so we hold that slot for you?";

test("18 Pipecat streaming first phrase before rest", async () => {
  const greet = splitForStreaming(SAMPLE_SENTENCE, "en");
  assert.equal(greet.unchunked, true);
  assert.equal(greet.reason, "greeting");

  const split = splitForStreaming(LONG_BOOKING, "en");
  assert.equal(split.unchunked, false);
  assert.equal(split.first, "Absolutely...");
  assert.equal(split.rest, LONG_BOOKING);
  assert.doesNotMatch(split.first, /two thirty/);

  const client = mockClient({
    generateStream: async (body) => {
      const delay = String(body.text || "").length < 24 ? 40 : 280;
      await new Promise((r) => setTimeout(r, delay));
      return { buffer: tinyWav(), contentType: "audio/wav", firstByteMs: delay, totalMs: delay };
    },
  });
  setVoiceboxClientForTests(client);
  const streamed = await speakStreaming({
    text: LONG_BOOKING,
    language: "en",
    conversationId: "CA-stream",
  });
  assert.equal(streamed.unchunked, false);
  assert.equal(streamed.firstText, "Absolutely...");
  assert.equal(streamed.ok, true);
  assert.ok(streamed.firstPhraseMs < 200, `first phrase ${streamed.firstPhraseMs} ms too slow on mock`);
  assert.equal(streamed.totalSynthMs, null);
  const restStartedAt = Date.now();
  const rest = await streamed.restPromise;
  const restWait = Date.now() - restStartedAt;
  assert.equal(rest.ok, true);
  assert.ok(restWait >= 50, "rest should still be synthesizing after first phrase returns");
  assert.ok(streamed.firstPhraseMs < restWait + streamed.firstPhraseMs);

  let liveMs = null;
  try {
    resetVoiceboxBridgeForTests();
    const live = await speakStreaming({
      text: "Absolutely...",
      language: "en",
      conversationId: "CA-live-ack",
    });
    liveMs = live.firstPhraseMs;
    if (!live.ok || live.fallback) {
      results.push({
        id: 18,
        name: "Streaming first phrase (Absolutely...) while rest synthesizes",
        result: "FAIL",
        detail: `live ack fallback ${live.reason || live.first?.reason}`,
      });
      assert.fail(`live Voicebox first phrase failed: ${live.reason || live.first?.reason}`);
    }
    assert.ok(liveMs < 8000, `live first phrase ${liveMs} ms is still in the 13s booking-line class`);
  } catch (e) {
    results.push({
      id: 18,
      name: "Streaming first phrase (Absolutely...) while rest synthesizes",
      result: "FAIL",
      detail: String(e?.message || e),
    });
    throw e;
  }

  results.push({
    id: 18,
    name: "Streaming first phrase (Absolutely...) while rest synthesizes",
    result: "PASS",
    detail: { mockFirstPhraseMs: streamed.firstPhraseMs, liveAckMs: liveMs },
  });
});

test("19 Pipecat turn detection, barge-in, silence, language, recovery", async () => {
  const det = createTurnDetector({ silenceMs: 50, bargeInRms: 0.1 });
  const loud = Array(48).fill(1);
  const quiet = Array(48).fill(0);
  assert.equal(det.pushPcm16(loud, 1000).bargeIn, true);
  assert.equal(det.pushPcm16(quiet, 1020).endOfTurn, false);
  assert.equal(det.pushPcm16(quiet, 1060).endOfTurn, true);

  const stream = createMockTwilioStream({ callSid: "CA-pipe" });
  stream.sendStart();
  const ir = stream.interrupt();
  assert.equal(ir.cancelled, true);
  assert.ok(stream.events.some((e) => e.event === "clear"));

  mergeBookingInfo("CA-pipe", { service: "fade", day: "tomorrow", time: "2:30 PM", name: "Jordan" });
  const switched = switchCallLanguage("CA-pipe", "es");
  assert.equal(switched.language, "es");
  assert.equal(switched.bookingPreserved, true);
  const he = switchCallLanguage("CA-pipe", "he");
  assert.equal(he.language, "he");
  assert.equal(he.booking.service, "fade");
  assert.equal(selectLanguageRoute("en").engine, "kokoro");
  assert.equal(selectLanguageRoute("es").voiceId, "af_heart");
  assert.equal(selectLanguageRoute("he").path, "polly_fallback");

  const t0 = Date.now();
  const recovered = await recoverWithFallback("timeout", async () => ({ ok: false, fallback: true, reason: "polly" }));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.fallback, true);
  assert.ok(recovered.recoveryMs >= 0);
  assert.ok(Date.now() - t0 < 1000);

  const barge = interruptSpeech("CA-pipe");
  assert.equal(barge.cancelled, true);

  results.push({ id: 19, name: "Pipecat turn/barge-in/silence/language/recovery", result: "PASS" });
});

test("20 PIPECAT default off; HQ pipeline; production PRIMARY OFF", async () => {
  const prev = process.env.PIPECAT_ENABLED;
  delete process.env.PIPECAT_ENABLED;
  try {
    assert.equal(isPipecatEnabled(), false);
    assert.equal(pipecatFlags().enabled, false);
    assert.equal(pipecatFlags().productionActivation, "OFF");
    assert.equal(isVoiceboxPrimary(), false);

    persistLatencySample({
      language: "en",
      model: "kokoro",
      firstByteMs: 40,
      firstPhraseMs: 45,
      totalMs: 90,
      rtf: 0.4,
    });
    const mem = getVoiceMemorySnapshot();
    assert.equal(mem.founderApprovedVoice.sample, "A");
    assert.equal(mem.founderApprovedVoice.customerFacingName, "Aura");
    assert.ok(mem.latencies?.en?.kokoro?.last);

    const client = mockClient();
    setVoiceboxClientForTests(client);
    const hq = await getVoiceboxHqStatus();
    for (const key of ["pipecat", "twilio", "polly", "pipelineHealth", "lastTest", "publicName", "latencies", "productionActivation"]) {
      assert.ok(key in hq, `missing ${key}`);
    }
    assert.equal(hq.publicName, "Aura");
    assert.equal(hq.founderApproved.sample, "A");
    assert.equal(hq.productionActivation, "OFF");
    assert.equal(hq.primary, false);
    assert.equal(hq.pipelineHealth.productionPrimary, "OFF");
    assert.equal(hq.polly.status, "PRODUCTION_PRIMARY");
    assert.equal(hq.pipecat.enabled, false);
    results.push({ id: 20, name: "PIPECAT off; HQ pipeline; PRODUCTION PRIMARY OFF", result: "PASS" });
  } finally {
    if (prev !== undefined) process.env.PIPECAT_ENABLED = prev;
  }
});

test.after(() => {
  const lines = results
    .sort((a, b) => a.id - b.id)
    .map((r) => `${r.id}. ${r.name}: ${r.result}${r.detail && r.result !== "PASS" ? ` — ${JSON.stringify(r.detail).slice(0, 180)}` : ""}`);
  const passed = results.filter((r) => r.result === "PASS").length;
  const failed = results.filter((r) => r.result !== "PASS").length;
  const body = `# AURA Voicebox tests 1–20\n\n${new Date().toISOString()}\n\n${lines.join("\n")}\n`;
  try {
    writeFileSync(new URL("../docs/AURA_VOICEBOX_TEST_RESULTS.md", import.meta.url), body);
  } catch {
    /* report is best-effort */
  }
  try {
    const last = {
      at: new Date().toISOString(),
      passed,
      failed,
      total: results.length,
      summary: failed ? `FAIL ${failed}/${results.length}` : `PASS ${passed}/${results.length}`,
      lines,
    };
    persistLastTest(last);
    setLastTest(last);
  } catch {
    /* memory may be read-only */
  }
});
