/**
 * Injected transcript/noise-event harness (no live microphone / TV / PSTN).
 * Writes docs/AURA_VOICE_PIPELINE_TEST_REPORT.md
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runSimpleBookingTurn, resetSimpleBookingState } from "../auraVoiceSimpleBookingFlow.js";

const require = createRequire(import.meta.url);
const { evaluateSpeechInput, rememberAssistantSpeech, createMulawSpeechGate } =
  require("../auraVoiceNoiseControl.cjs");
const {
  beginCallerTurn,
  applyRepeatGuard,
  recordAuraTurn,
  markBargeIn,
  shouldResumeInterruptedResponse,
  snapshotLedger,
  resetAllCallRuntime,
  runExclusiveTurn,
} = require("../auraVoiceCallRuntime.cjs");

const scenarios = [];

function record(id, name, { events, result, physicallyTested = false, notes = "" }) {
  scenarios.push({
    id,
    name,
    events,
    result,
    physicallyTested,
    notes,
    at: new Date().toISOString(),
  });
}

function injectSpeech(callSid, speechText, confidenceRaw, extra = {}) {
  return evaluateSpeechInput({
    callSid,
    speechText,
    confidenceRaw,
    isBargeInCandidate: Boolean(extra.bargeIn),
    isWelcome: false,
    isNoSpeech: false,
  });
}

resetAllCallRuntime();

// 1 TV
{
  const sid = "H1";
  const ev = [
    { kind: "transcript", text: "Coming up next after the commercial break", confidence: 0.91 },
  ];
  const gate = injectSpeech(sid, ev[0].text, ev[0].confidence);
  const spoke = gate.action !== "silent_listen" && gate.action !== "reject_prompt";
  record(1, "TV dialogue in room", {
    events: ev,
    result: { gate: gate.action, reason: gate.reason, auraSpoke: spoke },
    notes: "Injected STT only. Could NOT play a physical TV next to a phone.",
  });
}

// 2 Music / radio
{
  const sid = "H2";
  const ev = [{ kind: "transcript", text: "You're listening to the now playing radio station mix", confidence: 0.86 }];
  const gate = injectSpeech(sid, ev[0].text, ev[0].confidence);
  record(2, "Music / radio bed", {
    events: ev,
    result: { gate: gate.action, reason: gate.reason, auraSpoke: gate.action === "accept" },
    notes: "Injected STT. No live speaker/music test.",
  });
}

// 3 Other people
{
  const sid = "H3";
  const ev = [{ kind: "transcript", text: 'He said "grab the clippers" and she said "not now"', confidence: 0.8 }];
  const gate = injectSpeech(sid, ev[0].text, ev[0].confidence);
  record(3, "Other people talking", {
    events: ev,
    result: { gate: gate.action, reason: gate.reason, auraSpoke: gate.action === "accept" },
    notes: "Keyword multi-speaker heuristic on transcript. No diarization / live room.",
  });
}

// 4 Own TTS echo
{
  const sid = "H4";
  const asst = "Thank you for calling the IFCDC Barbers App. This is AURA.";
  rememberAssistantSpeech(sid, asst);
  const gate = injectSpeech(sid, asst, 0.94);
  record(4, "Own TTS / echo", {
    events: [{ kind: "assistant_tts", text: asst }, { kind: "transcript_echo", text: asst, confidence: 0.94 }],
    result: { gate: gate.action, reason: gate.reason, auraSpoke: gate.action === "accept" },
    notes: "Simulated loopback of last assistant line. No analog handset echo.",
  });
}

// 5 Duplicate transcript
{
  const sid = "H5";
  const a = beginCallerTurn(sid, { speech: "Friday afternoon fade", confidence: 0.9 });
  rememberReplaySafe(sid, a.turnId);
  const b = beginCallerTurn(sid, { speech: "Friday afternoon fade", confidence: 0.9 });
  record(5, "Duplicate transcript / webhook retry", {
    events: [
      { kind: "transcript", text: "Friday afternoon fade" },
      { kind: "retry_same_transcript", text: "Friday afternoon fade" },
    ],
    result: { firstTurnId: a.turnId, secondDuplicate: b.duplicate, sameId: a.turnId === b.turnId },
    notes: "In-process fingerprint window. No Twilio retry from the carrier.",
  });
}

function rememberReplaySafe(callSid, turnId) {
  const { rememberReplay } = require("../auraVoiceCallRuntime.cjs");
  rememberReplay(callSid, { turnId, twiml: "<Response>once</Response>", reply: "once" });
}

// 6 Double generation
{
  const sid = "H6";
  let gens = 0;
  const jobs = [
    runExclusiveTurn(sid, async () => {
      gens += 1;
      return { reply: "What day works?" };
    }),
    runExclusiveTurn(sid, async () => {
      gens += 1;
      return { reply: "What day works?" };
    }),
  ];
  const outs = await Promise.all(jobs);
  record(6, "Multiple generations per turn", {
    events: [{ kind: "parallel_process_webhooks", count: 2 }],
    result: { generations: gens, sameReply: outs[0].reply === outs[1].reply },
    notes: "Coalesced in-process locks. No live double HTTP from Twilio.",
  });
}

// 7 Barge-in mid sentence
{
  const sid = "H7";
  recordAuraTurn(sid, { turnId: "long", text: "Our services include haircuts fades tapers beards and more..." });
  const barge = markBargeIn(sid, { turnId: "long" });
  const frag = injectSpeech(sid, "um", 0.7, { bargeIn: true });
  record(7, "Barge-in mid-sentence", {
    events: [
      { kind: "assistant_playing", text: "long service list" },
      { kind: "bargein_fragment", text: "um", confidence: 0.7 },
    ],
    result: {
      resumeOld: shouldResumeInterruptedResponse(),
      interrupted: barge.resumeOldResponse === false,
      fragment: frag.action,
    },
    notes: "State machine only. Twilio <Gather bargeIn> not exercised on a live call.",
  });
}

// 8 Remember booking info
{
  const sid = "H8";
  resetSimpleBookingState(sid);
  resetAllCallRuntime();
  await runSimpleBookingTurn({ callSid: sid, userInput: "__IFCDC_VOICE_WELCOME__", language: "en" });
  await runSimpleBookingTurn({ callSid: sid, userInput: "fade", language: "en" });
  await runSimpleBookingTurn({ callSid: sid, userInput: "tomorrow", language: "en" });
  const snap = snapshotLedger(sid);
  record(8, "Remembers current-call booking slots", {
    events: [
      { kind: "caller", text: "fade" },
      { kind: "caller", text: "tomorrow" },
    ],
    result: { service: snap.booking.service, day: snap.booking.day, pending: snap.pendingQuestions },
    notes: "In-memory ledger + booking machine. No PSTN call.",
  });
}

// 9 Do not re-ask established info
{
  const sid = "H9";
  resetSimpleBookingState(sid);
  await runSimpleBookingTurn({ callSid: sid, userInput: "__IFCDC_VOICE_WELCOME__", language: "en" });
  await runSimpleBookingTurn({ callSid: sid, userInput: "haircut", language: "en" });
  const again = await runSimpleBookingTurn({
    callSid: sid,
    userInput: "__IFCDC_NO_SPEECH__",
    language: "en",
  });
  const snap = snapshotLedger(sid);
  record(9, "No re-ask of established service on silence", {
    events: [{ kind: "caller", text: "haircut" }, { kind: "no_speech" }],
    result: {
      stage: again.stage,
      stillHasService: Boolean(snap.booking.service),
      replyAsksServiceAgain: /what service/i.test(again.reply || ""),
    },
    notes: "Silence stays on DAY. Greeting is not replayed.",
  });
}

// 10 Soft / normal speech still accepted
{
  const sid = "H10";
  const gate = injectSpeech(sid, "I need a fade tomorrow afternoon", 0.72);
  record(10, "Normal near-field speech accepted", {
    events: [{ kind: "transcript", text: "I need a fade tomorrow afternoon", confidence: 0.72 }],
    result: { gate: gate.action, reason: gate.reason },
    notes: "Confidence 0.72 listen-path. No live quiet talker.",
  });
}

// 11 Short barge-in ignored
{
  const sid = "H11";
  const gate = injectSpeech(sid, "hey", 0.95, { bargeIn: true });
  record(11, "Short barge-in fragment ignored", {
    events: [{ kind: "bargein", text: "hey", confidence: 0.95 }],
    result: { gate: gate.action, reason: gate.reason },
    notes: "Post-STT length gate. No live interrupt.",
  });
}

// 12 μ-law energy: HVAC-like vs sustained speech
{
  const gate = createMulawSpeechGate();
  const quiet = Buffer.alloc(160, 0x7f).toString("base64");
  const loud = Buffer.alloc(160, 0x00).toString("base64");
  let quietFwd = 0;
  let loudFwd = 0;
  for (let i = 0; i < 8; i += 1) if (gate.shouldForward(quiet, { assistantSpeaking: false })) quietFwd += 1;
  for (let i = 0; i < 8; i += 1) if (gate.shouldForward(loud, { assistantSpeaking: true })) loudFwd += 1;
  record(12, "Realtime μ-law energy vs idle / barge-in", {
    events: [
      { kind: "mulaw_idle_frames", count: 8 },
      { kind: "mulaw_loud_frames_while_assistant", count: 8 },
    ],
    result: { quietForwarded: quietFwd, loudForwardedAfterSustain: loudFwd },
    notes: "Synthetic μ-law bytes. Could NOT run Media Streams against a TV.",
  });
}

const passFail = scenarios.map((s) => {
  let ok = true;
  if (s.id === 1 || s.id === 2 || s.id === 4) ok = s.result.auraSpoke === false || s.result.gate === "silent_listen";
  if (s.id === 3) ok = s.result.gate !== "accept";
  if (s.id === 5) ok = s.result.secondDuplicate === true;
  if (s.id === 6) ok = s.result.generations === 1;
  if (s.id === 7) ok = s.result.resumeOld === false && s.result.fragment !== "accept";
  if (s.id === 8) ok = Boolean(s.result.service) && Boolean(s.result.day);
  if (s.id === 9) ok = s.result.stillHasService && s.result.replyAsksServiceAgain === false;
  if (s.id === 10) ok = s.result.gate === "accept" || s.result.gate === "confirm_critical";
  if (s.id === 11) ok = s.result.gate !== "accept";
  if (s.id === 12) ok = s.result.quietForwarded === 0 && s.result.loudForwardedAfterSustain < 8;
  return { ...s, ok };
});

const report = [];
report.push("# AURA voice pipeline test report");
report.push("");
report.push(`Generated: ${new Date().toISOString()}`);
report.push("");
report.push("This harness **injects transcripts, confidence scores, and synthetic μ-law frames**.");
report.push("It does **not** claim live microphone, television, or PSTN results.");
report.push("");
report.push("## Scenarios 1–12");
report.push("");
for (const s of passFail) {
  report.push(`### ${s.id}. ${s.name} — ${s.ok ? "PASS (harness)" : "FAIL (harness)"}`);
  report.push("");
  report.push(`- Physically tested: **${s.physicallyTested ? "yes" : "no"}**`);
  report.push("- Injected events:");
  for (const e of s.events) report.push(`  - \`${JSON.stringify(e)}\``);
  report.push(`- Result: \`${JSON.stringify(s.result)}\``);
  report.push(`- Notes: ${s.notes}`);
  report.push("");
}

report.push("## What could NOT be physically tested");
report.push("");
report.push("- Live handset / app mic with a TV or music playing in the room");
report.push("- Carrier AEC / Twilio enhanced STT on a real PSTN call");
report.push("- Analog echo from a speakerphone playing Polly TTS");
report.push("- Twilio webhook retries from the public internet");
report.push("- OpenAI Realtime Media Streams against live audio");
report.push("- iOS TestFlight AEC (no mobile client change in this pass)");
report.push("");
report.push("## Metrics (this harness run)");
report.push("");
report.push(`- Scenarios: ${passFail.length}`);
report.push(`- Harness passes: ${passFail.filter((s) => s.ok).length}`);
report.push(`- Harness fails: ${passFail.filter((s) => !s.ok).length}`);
report.push("");

const md = report.join("\n");
writeFileSync(new URL("../docs/AURA_VOICE_PIPELINE_TEST_REPORT.md", import.meta.url), md);
console.log(md);
const failed = passFail.filter((s) => !s.ok);
if (failed.length) {
  console.error("Harness failures:", failed.map((s) => s.id).join(", "));
  process.exit(1);
}
