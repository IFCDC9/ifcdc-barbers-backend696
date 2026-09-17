/**
 * Per-call voice runtime: one CallSid session, turn IDs, Twilio/transcript
 * idempotency, in-call ledger, barge-in, booking machine, safe turn traces.
 * In-memory Map (one Node process). Not wiped between Twilio POSTs.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CAP = 2000;
const RECENT_AURA = 6;
const DEDUP_MS = 15000;
const TRACE_CAP = 80;
const TRACE_FILE = path.join(__dirname, "logs", "aura-voice-turns.log");

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();
/** @type {object[]} */
const globalTraces = [];

const stats = {
  turnsAccepted: 0,
  turnsDuplicate: 0,
  turnsSuppressedRepeat: 0,
  turnsInterimDropped: 0,
  bargeIns: 0,
  generationsCoalesced: 0,
};

function pruneMap(map) {
  while (map.size > CAP) {
    const k = map.keys().next().value;
    if (k === undefined) break;
    map.delete(k);
  }
}

function now() {
  return Date.now();
}

function emptyBooking() {
  return { service: null, day: null, time: null, name: null, confirmed: false };
}

function emptyBookingMachine() {
  return { step: "start", data: {}, completed: false };
}

function createSession(callSid) {
  const sid = String(callSid || "").trim();
  return {
    callSid: sid,
    callSessionId: sid || `anon_${now().toString(36)}`,
    createdAt: now(),
    seq: 0,
    greeted: false,
    callerTurns: [],
    auraTurns: [],
    messages: [],
    completedActions: [],
    booking: emptyBooking(),
    bookingMachine: emptyBookingMachine(),
    questionsAnswered: [],
    pendingQuestions: [],
    currentIntent: null,
    lastConfirmed: null,
    language: null,
    playback: {
      speaking: false,
      interrupted: false,
      interruptedTurnId: null,
      currentAudioId: null,
      state: "idle",
    },
    lastAcceptedTurnId: null,
    lastCompletedTurnId: null,
    lastTwimlTurnId: null,
    lastTwiml: "",
    lastReply: "",
    lastAudioId: null,
    fingerprints: new Map(),
    twilioEvents: new Map(),
    turns: new Map(),
    pendingInput: null,
    traces: [],
  };
}

function getCallRuntime(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return createSession("");
  let s = sessions.get(k);
  if (!s) {
    s = createSession(k);
    sessions.set(k, s);
    pruneMap(sessions);
  }
  return s;
}

function nextTurnId(callSid) {
  const s = getCallRuntime(callSid);
  s.seq += 1;
  return `${s.callSessionId || s.callSid || "anon"}:t${s.seq}:${now().toString(36)}`;
}

function newAudioId(turnId) {
  const rand = crypto.randomBytes(4).toString("hex");
  return `aud_${String(turnId || "t").replace(/[^a-z0-9:]/gi, "").slice(-24) || "t"}:${rand}`;
}

function normalizeFingerprint(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function hashTranscript({ speech = "", digits = "" } = {}) {
  const payload = `${normalizeFingerprint(speech)}|${String(digits || "").trim()}`;
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 20);
}

/** Transcript only — never include Confidence (retries jitter and would mint a new turn). */
function eventFingerprint({ speech, digits }) {
  return `${normalizeFingerprint(speech)}|${String(digits || "").trim()}`;
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "and",
  "or",
  "of",
  "i",
  "you",
  "we",
  "please",
  "just",
  "that",
  "this",
  "is",
  "are",
  "im",
  "can",
  "me",
  "your",
  "our",
  "with",
  "would",
  "like",
  "want",
  "aura",
  "okay",
  "ok",
  "alright",
  "got",
  "it",
  "what",
  "which",
  "how",
  "when",
]);

function stem(w) {
  let x = String(w || "");
  if (x.endsWith("ing") && x.length > 5) x = x.slice(0, -3);
  else if (x.endsWith("ed") && x.length > 4) x = x.slice(0, -2);
  else if (x.endsWith("s") && x.length > 3 && !x.endsWith("ss")) x = x.slice(0, -1);
  return x;
}

function contentTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map(stem)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let hit = 0;
  for (const w of sa) if (sb.has(w)) hit += 1;
  return hit / (sa.size + sb.size - hit);
}

function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let hit = 0;
  for (const x of a) if (sb.has(x)) hit += 1;
  return (2 * hit) / (a.length + b.length);
}

function semanticSimilarity(a, b) {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const jac = jaccard(ta, tb);
  const dic = dice(bigrams(ta), bigrams(tb));
  const prefix =
    normalizeFingerprint(a).slice(0, 48) &&
    normalizeFingerprint(a).slice(0, 48) === normalizeFingerprint(b).slice(0, 48)
      ? 0.15
      : 0;
  return Math.min(1, jac * 0.55 + dic * 0.35 + prefix);
}

function userAskedRepeat(text) {
  return /\b(repeat|say that again|what did you say|come again|pardon)\b/i.test(String(text || ""));
}

function ledgerHasNewInfo(session, candidate) {
  const t = String(candidate || "").toLowerCase();
  const b = session.booking || emptyBooking();
  if (b.service && t.includes(String(b.service).toLowerCase().slice(0, 12))) return false;
  const slotish = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    t,
  );
  const pending = session.pendingQuestions || [];
  if (pending.length && slotish) return true;
  return false;
}

function getTurn(callSid, turnId) {
  if (!turnId) return null;
  return getCallRuntime(callSid).turns.get(String(turnId)) || null;
}

function getTurnByTwilioEvent(callSid, twilioEventId) {
  const id = String(twilioEventId || "").trim();
  if (!id) return null;
  const s = getCallRuntime(callSid);
  const turnId = s.twilioEvents.get(id);
  return turnId ? s.turns.get(turnId) || null : null;
}

function stashTurnInput(callSid, payload = {}) {
  const s = getCallRuntime(callSid);
  s.pendingInput = {
    text: String(payload.text || ""),
    turnId: payload.turnId || s.lastAcceptedTurnId,
    eventId: payload.eventId || null,
    twilioEventId: payload.twilioEventId || null,
    transcriptHash: payload.transcriptHash || null,
    confidence: payload.confidence ?? null,
    bargeInCandidate: Boolean(payload.bargeInCandidate),
    source: payload.source || "gather",
    consumed: false,
    at: now(),
  };
  return s.pendingInput;
}

function peekPendingInput(callSid) {
  return getCallRuntime(callSid).pendingInput || null;
}

/**
 * Recover SpeechResult across /voice → /process Redirect and Twilio retries.
 * Same turn keeps the text; a later different turn does not see stale speech.
 */
function resolveTurnInput(callSid, { speech = "", digits = "", turnId = "" } = {}) {
  const spoken = String(speech || digits || "").trim();
  if (spoken) {
    const p = peekPendingInput(callSid);
    if (p && p.turnId === turnId) p.consumed = true;
    return { text: spoken, from: "webhook", pending: p };
  }
  const p = peekPendingInput(callSid);
  if (p && p.turnId && (!turnId || p.turnId === turnId) && String(p.text || "").trim()) {
    p.consumed = true;
    return { text: String(p.text), from: "pending", pending: p };
  }
  return { text: "", from: "empty", pending: p };
}

function isCallGreeted(callSid) {
  return Boolean(getCallRuntime(callSid).greeted);
}

function markCallGreeted(callSid) {
  const s = getCallRuntime(callSid);
  s.greeted = true;
  return s.greeted;
}

function appendMessage(callSid, role, text, turnId) {
  const s = getCallRuntime(callSid);
  const t = String(text || "").trim();
  if (!t) return;
  s.messages.push({ role, text: t.slice(0, 800), turnId: turnId || null, at: now() });
  if (s.messages.length > 24) s.messages.splice(0, s.messages.length - 24);
}

function conversationMessages(callSid) {
  return getCallRuntime(callSid).messages.slice(-8).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text,
  }));
}

function getBookingMachine(callSid) {
  const s = getCallRuntime(callSid);
  if (!s.bookingMachine) s.bookingMachine = emptyBookingMachine();
  if (s.greeted && s.bookingMachine.step === "start") s.bookingMachine.step = "service";
  return s.bookingMachine;
}

function resetBookingMachine(callSid) {
  const s = getCallRuntime(callSid);
  s.bookingMachine = emptyBookingMachine();
}

/**
 * Begin a caller turn. Interim/unstable transcripts are not turns.
 * Duplicate RequestSid / transcript hash reuse the same turnId.
 * Replay TwiML only if it belongs to THIS turn — never the previous Play.
 */
function beginCallerTurn(callSid, opts = {}) {
  const {
    speech = "",
    digits = "",
    confidence = null,
    source = "gather",
    twilioEventId = "",
    transcriptFinal = true,
    unstable = "",
  } = opts;
  const s = getCallRuntime(callSid);
  const spoken = String(speech || "").trim();
  const dtmf = String(digits || "").trim();
  const interimOnly = Boolean(String(unstable || "").trim()) && !spoken && !dtmf;
  const notFinal = transcriptFinal === false || interimOnly;

  if (notFinal) {
    stats.turnsInterimDropped += 1;
    return {
      accepted: false,
      duplicate: false,
      interim: true,
      turnId: s.lastAcceptedTurnId || "",
      eventId: "",
      twilioEventId: String(twilioEventId || "").trim(),
      transcriptHash: hashTranscript({ speech: unstable, digits: dtmf }),
      transcriptFinal: false,
      reason: "interim_not_a_turn",
      replayTwiml: "",
    };
  }

  const fp = eventFingerprint({ speech: spoken, digits: dtmf });
  const transcriptHash = hashTranscript({ speech: spoken, digits: dtmf });
  const eventKey = String(twilioEventId || "").trim();

  if (eventKey && s.twilioEvents.has(eventKey)) {
    const existing = s.turns.get(s.twilioEvents.get(eventKey));
    if (existing) {
      stats.turnsDuplicate += 1;
      const replay = existing.twiml && existing.playback !== "interrupted" ? existing.twiml : "";
      return {
        accepted: false,
        duplicate: true,
        turnId: existing.turnId,
        eventId: existing.eventId,
        twilioEventId: eventKey,
        transcriptHash: existing.transcriptHash,
        transcriptFinal: true,
        reason: "duplicate_twilio_event",
        replayTwiml: replay,
        replayReply: existing.reply || "",
        audioId: existing.audioId || null,
        sameTurn: !replay,
      };
    }
  }

  const prev = s.fingerprints.get(fp) || s.fingerprints.get(transcriptHash);
  if (prev && now() - prev.at < DEDUP_MS) {
    const existing = s.turns.get(prev.turnId);
    if (existing) {
      if (eventKey) s.twilioEvents.set(eventKey, existing.turnId);
      const complete = Boolean(existing.twiml) && existing.playback !== "interrupted";
      if (complete) {
        stats.turnsDuplicate += 1;
        return {
          accepted: false,
          duplicate: true,
          turnId: existing.turnId,
          eventId: existing.eventId,
          twilioEventId: eventKey || existing.twilioEventId,
          transcriptHash: existing.transcriptHash,
          transcriptFinal: true,
          reason: "duplicate_transcript",
          replayTwiml: existing.twiml,
          replayReply: existing.reply || "",
          audioId: existing.audioId || null,
        };
      }
      stats.turnsDuplicate += 1;
      return {
        accepted: true,
        duplicate: false,
        sameTurn: true,
        turnId: existing.turnId,
        eventId: existing.eventId,
        twilioEventId: eventKey || existing.twilioEventId,
        transcriptHash: existing.transcriptHash,
        transcriptFinal: true,
        reason: "in_flight_same_turn",
        replayTwiml: "",
        audioId: existing.audioId || null,
      };
    }
  }

  const turnId = nextTurnId(callSid);
  const eventId = `${turnId}:e`;
  const audioId = newAudioId(turnId);
  const rec = {
    turnId,
    eventId,
    twilioEventId: eventKey || eventId,
    transcriptHash,
    userText: String(spoken || dtmf || "").slice(0, 500),
    confidence,
    source,
    at: now(),
    accepted: true,
    final: true,
    status: "pending",
    reply: "",
    twiml: "",
    audioId,
    playback: "idle",
  };
  s.turns.set(turnId, rec);
  s.fingerprints.set(fp, { turnId, eventId, at: now() });
  s.fingerprints.set(transcriptHash, { turnId, eventId, at: now() });
  if (eventKey) s.twilioEvents.set(eventKey, turnId);
  if (s.fingerprints.size > 120) {
    const first = s.fingerprints.keys().next().value;
    if (first !== undefined) s.fingerprints.delete(first);
  }
  s.lastAcceptedTurnId = turnId;
  s.playback.interrupted = false;
  stats.turnsAccepted += 1;
  s.callerTurns.push({
    turnId,
    eventId,
    twilioEventId: rec.twilioEventId,
    transcriptHash,
    text: rec.userText,
    confidence,
    source,
    at: rec.at,
    accepted: true,
  });
  if (s.callerTurns.length > 40) s.callerTurns.splice(0, s.callerTurns.length - 40);
  if (rec.userText && !/^__IFCDC_/.test(rec.userText)) {
    appendMessage(callSid, "user", rec.userText, turnId);
  }
  stashTurnInput(callSid, {
    text: rec.userText,
    turnId,
    eventId,
    twilioEventId: rec.twilioEventId,
    transcriptHash,
    confidence,
    source,
    bargeInCandidate: source === "bargein",
  });
  return {
    accepted: true,
    duplicate: false,
    sameTurn: false,
    turnId,
    eventId,
    twilioEventId: rec.twilioEventId,
    transcriptHash,
    transcriptFinal: true,
    reason: "new",
    replayTwiml: "",
    audioId,
  };
}

function recordRejectedInput(callSid, { text, reason }) {
  const s = getCallRuntime(callSid);
  s.callerTurns.push({
    turnId: nextTurnId(callSid),
    text: String(text || "").slice(0, 300),
    reason: String(reason || ""),
    accepted: false,
    at: now(),
  });
}

function recordAuraTurn(callSid, { turnId, text, interrupted = false, audioId = null } = {}) {
  const s = getCallRuntime(callSid);
  const tid = turnId || s.lastAcceptedTurnId;
  const spoken = String(text || "").slice(0, 800);
  s.auraTurns.push({
    turnId: tid,
    text: spoken,
    interrupted: Boolean(interrupted),
    audioId: audioId || null,
    at: now(),
  });
  if (s.auraTurns.length > 40) s.auraTurns.splice(0, s.auraTurns.length - 40);
  s.lastReply = spoken;
  if (audioId) s.lastAudioId = audioId;
  appendMessage(callSid, "assistant", spoken, tid);
  const turn = tid ? s.turns.get(tid) : null;
  if (turn) {
    turn.reply = spoken;
    if (audioId) turn.audioId = audioId;
    if (interrupted) turn.playback = "interrupted";
  }
}

function markPlaybackSpeaking(callSid, speaking, audioId = null) {
  const s = getCallRuntime(callSid);
  s.playback.speaking = Boolean(speaking);
  s.playback.state = speaking ? "playing" : "idle";
  if (audioId) s.playback.currentAudioId = audioId;
  if (speaking) s.playback.interrupted = false;
}

let bargeInListener = null;
function setBargeInListener(fn) {
  bargeInListener = typeof fn === "function" ? fn : null;
}

function markBargeIn(callSid, { turnId } = {}) {
  const s = getCallRuntime(callSid);
  s.playback.speaking = false;
  s.playback.interrupted = true;
  s.playback.state = "interrupted";
  s.playback.interruptedTurnId = turnId || s.lastCompletedTurnId || s.auraTurns.at(-1)?.turnId || null;
  stats.bargeIns += 1;
  const last = s.auraTurns.at(-1);
  if (last) last.interrupted = true;
  const interrupted = s.playback.interruptedTurnId ? s.turns.get(s.playback.interruptedTurnId) : null;
  if (interrupted) {
    interrupted.playback = "interrupted";
    interrupted.twiml = "";
  }
  if (s.lastTwimlTurnId && s.lastTwimlTurnId === s.playback.interruptedTurnId) {
    s.lastTwiml = "";
    s.lastTwimlTurnId = null;
  }
  try {
    if (bargeInListener) bargeInListener(callSid, s.playback.interruptedTurnId);
  } catch (e) {
    console.warn("[aura/runtime] barge-in listener:", e?.message || e);
  }
  return { interruptedTurnId: s.playback.interruptedTurnId, resumeOldResponse: false };
}

function setCallLanguage(callSid, language) {
  const s = getCallRuntime(callSid);
  const next = String(language || "").trim().toLowerCase().split(/[-_]/)[0];
  if (next === "iw") s.language = "he";
  else if (next === "he" || next === "es" || next === "en") s.language = next;
  return s.language;
}

function getCallLanguage(callSid) {
  return getCallRuntime(callSid).language;
}

function shouldResumeInterruptedResponse() {
  return false;
}

function mergeBookingInfo(callSid, partial = {}) {
  const s = getCallRuntime(callSid);
  for (const k of ["service", "day", "time", "name"]) {
    if (partial[k] != null && String(partial[k]).trim()) s.booking[k] = String(partial[k]).trim();
  }
  if (partial.confirmed === true) {
    s.booking.confirmed = true;
    s.lastConfirmed = { ...s.booking, at: now() };
    s.completedActions.push({ kind: "booking_confirmed", at: now() });
  }
}

function setPendingQuestion(callSid, question, intent = null) {
  const s = getCallRuntime(callSid);
  const q = String(question || "").trim();
  s.pendingQuestions = q ? [q] : [];
  if (intent) s.currentIntent = intent;
}

function markQuestionAnswered(callSid, question) {
  const s = getCallRuntime(callSid);
  const q = String(question || "").trim();
  if (q) s.questionsAnswered.push(q);
  s.pendingQuestions = s.pendingQuestions.filter((x) => x !== q);
}

function snapshotLedger(callSid) {
  const s = getCallRuntime(callSid);
  return {
    callSessionId: s.callSessionId,
    greeted: s.greeted,
    booking: { ...s.booking },
    pendingQuestions: [...s.pendingQuestions],
    questionsAnswered: s.questionsAnswered.slice(-8),
    currentIntent: s.currentIntent,
    language: s.language,
    lastConfirmed: s.lastConfirmed,
    completedActions: s.completedActions.slice(-8),
    recentCaller: s.callerTurns.filter((t) => t.accepted).slice(-6).map((t) => t.text),
    recentAura: s.auraTurns.slice(-RECENT_AURA).map((t) => t.text),
    playbackInterrupted: s.playback.interrupted,
    playbackState: s.playback.state,
    lastAcceptedTurnId: s.lastAcceptedTurnId,
    lastAudioId: s.lastAudioId,
  };
}

function ledgerContextBlock(callSid) {
  const snap = snapshotLedger(callSid);
  const b = snap.booking;
  const collected = [
    b.service && `service=${b.service}`,
    b.day && `day=${b.day}`,
    b.time && `time=${b.time}`,
    b.name && `name=${b.name}`,
    b.confirmed && "booking=confirmed",
  ].filter(Boolean);
  const lines = [
    "In-call ledger (this call only — do not re-ask collected fields):",
    collected.length ? `Collected: ${collected.join("; ")}` : "Collected: (none yet)",
    snap.pendingQuestions.length ? `Pending: ${snap.pendingQuestions.join("; ")}` : "Pending: (none)",
    snap.currentIntent ? `Intent: ${snap.currentIntent}` : "",
    snap.recentCaller.length ? `Caller recently said: ${snap.recentCaller.slice(-3).join(" | ")}` : "",
    snap.recentAura.length ? `You already said: ${snap.recentAura.slice(-2).join(" | ")}` : "",
    "Do not greet again. Do not dump policy. Ask only the next missing booking field.",
  ].filter(Boolean);
  return lines.join("\n");
}

function contextSummary(callSid) {
  const snap = snapshotLedger(callSid);
  const b = snap.booking;
  const bits = [
    snap.greeted ? "greeted" : "not_greeted",
    b.service && `svc=${b.service}`,
    b.day && `day=${b.day}`,
    b.time && `time=${b.time}`,
    b.name && `name=${b.name}`,
    snap.currentIntent && `intent=${snap.currentIntent}`,
    snap.pendingQuestions[0] && `pending=${snap.pendingQuestions[0]}`,
    snap.language && `lang=${snap.language}`,
  ].filter(Boolean);
  return bits.join("; ").slice(0, 240);
}

function applyRepeatGuard(callSid, reply, { userText = "" } = {}) {
  const s = getCallRuntime(callSid);
  const text = String(reply || "").trim();
  if (!text) return { reply: text, suppressed: false, similarity: 0 };
  if (userAskedRepeat(userText)) return { reply: text, suppressed: false, similarity: 0, reason: "user_requested" };
  if (/^\s*(hi|hello|hola)[,.]?\s+(this is Aura|soy Aura)\b/i.test(text) && s.auraTurns.some((t) => /^\s*(hi|hello|hola)[,.]?\s+(this is Aura|soy Aura)\b/i.test(t.text || ""))) {
    stats.turnsSuppressedRepeat += 1;
    const pending = s.pendingQuestions[0];
    const rewrite = pending || "I'm here. What would you like to do next?";
    return { reply: rewrite, suppressed: true, similarity: 1, original: text, reason: "re_greeting" };
  }

  let best = 0;
  for (const prev of s.auraTurns.slice(-RECENT_AURA)) {
    const sim = semanticSimilarity(text, prev.text);
    if (sim > best) best = sim;
  }
  if (best >= 0.72 && !ledgerHasNewInfo(s, text)) {
    stats.turnsSuppressedRepeat += 1;
    const pending = s.pendingQuestions[0];
    const rewrite = pending
      ? `I already have that. ${pending}`
      : "I already noted that. What else do you need for this booking?";
    return { reply: rewrite, suppressed: true, similarity: best, original: text };
  }
  return { reply: text, suppressed: false, similarity: best };
}

function rememberReplay(callSid, { turnId, twiml, reply, audioId } = {}) {
  const s = getCallRuntime(callSid);
  const tid = turnId || s.lastAcceptedTurnId;
  const xml = String(twiml || "");
  const turn = tid ? s.turns.get(tid) : null;
  if (turn && turn.playback === "interrupted") {
    return;
  }
  s.lastTwiml = xml;
  s.lastReply = String(reply || "");
  s.lastTwimlTurnId = tid || null;
  s.lastCompletedTurnId = tid || s.lastCompletedTurnId;
  if (tid) s.lastAcceptedTurnId = tid;
  if (audioId) s.lastAudioId = audioId;
  if (turn) {
    turn.twiml = xml;
    turn.reply = String(reply || turn.reply || "");
    turn.status = "complete";
    turn.playback = "playing";
    if (audioId) turn.audioId = audioId;
  }
}

function getReplay(callSid, turnId = null) {
  const s = getCallRuntime(callSid);
  const tid = turnId || s.lastTwimlTurnId || s.lastCompletedTurnId;
  const turn = tid ? s.turns.get(tid) : null;
  if (turn?.twiml && turn.playback !== "interrupted") {
    return { twiml: turn.twiml, reply: turn.reply, turnId: turn.turnId, audioId: turn.audioId };
  }
  if (!turnId && s.lastTwiml && s.lastTwimlTurnId) {
    return { twiml: s.lastTwiml, reply: s.lastReply, turnId: s.lastTwimlTurnId, audioId: s.lastAudioId };
  }
  return null;
}

async function runExclusiveTurn(callSid, fn) {
  const k = String(callSid || "").trim() || "__anon__";
  const existing = inflight.get(k);
  if (existing) {
    stats.generationsCoalesced += 1;
    return existing;
  }
  const p = Promise.resolve()
    .then(fn)
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, p);
  return p;
}

function redactTraceValue(v) {
  return String(v ?? "")
    .replace(/\+1\d{10}/g, "+1**********")
    .replace(/\b\d{10,}\b/g, "[digits]")
    .replace(/hmac[^\s"]*/gi, "[redacted]")
    .replace(/authorization[:\s]+\S+/gi, "[redacted]")
    .replace(/tunnel[_-]?secret[^\s"]*/gi, "[redacted]")
    .slice(0, 500);
}

function recordTurnTrace(callSid, partial = {}) {
  const s = getCallRuntime(callSid);
  const turn = getTurn(callSid, partial.TURN_ID || s.lastAcceptedTurnId);
  const row = {
    at: new Date().toISOString(),
    CALL_SESSION_ID: s.callSessionId,
    TURN_ID: partial.TURN_ID || turn?.turnId || s.lastAcceptedTurnId || "",
    TWILIO_EVENT_ID: redactTraceValue(partial.TWILIO_EVENT_ID || turn?.twilioEventId || ""),
    TRANSCRIPT_FINAL: partial.TRANSCRIPT_FINAL !== false,
    TRANSCRIPT_HASH: partial.TRANSCRIPT_HASH || turn?.transcriptHash || "",
    DUPLICATE: Boolean(partial.DUPLICATE),
    USER_TEXT: redactTraceValue(partial.USER_TEXT || turn?.userText || ""),
    INTENT: redactTraceValue(partial.INTENT || s.currentIntent || ""),
    CONTEXT_SUMMARY: redactTraceValue(partial.CONTEXT_SUMMARY || contextSummary(callSid)),
    AURA_RESPONSE_TEXT: redactTraceValue(partial.AURA_RESPONSE_TEXT || turn?.reply || s.lastReply || ""),
    AUDIO_ID: partial.AUDIO_ID || turn?.audioId || s.lastAudioId || "",
    PLAYBACK_STATE: partial.PLAYBACK_STATE || s.playback.state || "idle",
    PLAYBACK_INTERRUPTED: Boolean(s.playback.interrupted),
    PLAYBACK_AUDIO_ID: s.playback.currentAudioId || partial.AUDIO_ID || "",
    LATENCY_MS: Number.isFinite(Number(partial.LATENCY_MS)) ? Number(partial.LATENCY_MS) : null,
  };
  s.traces.push(row);
  if (s.traces.length > TRACE_CAP) s.traces.splice(0, s.traces.length - TRACE_CAP);
  globalTraces.push(row);
  if (globalTraces.length > 400) globalTraces.splice(0, globalTraces.length - 400);
  try {
    console.log("[aura/turn-trace]", JSON.stringify(row));
  } catch {
    /* ignore */
  }
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(row)}\n`);
  } catch (e) {
    if (!recordTurnTrace._fsWarned) {
      recordTurnTrace._fsWarned = true;
      console.warn("[aura/turn-trace] log file skipped:", e?.message || e);
    }
  }
  return row;
}

function getTurnTraces(callSid, limit = 40) {
  const n = Math.max(1, Math.min(80, Number(limit) || 40));
  const k = String(callSid || "").trim();
  if (k) return (sessions.get(k)?.traces || []).slice(-n);
  return globalTraces.slice(-n);
}

function getRuntimeStats() {
  return { ...stats, activeCalls: sessions.size, inflight: inflight.size };
}

function resetCallRuntime(callSid) {
  const k = String(callSid || "").trim();
  if (k) {
    sessions.delete(k);
    inflight.delete(k);
  }
}

function resetAllCallRuntime() {
  sessions.clear();
  inflight.clear();
  globalTraces.length = 0;
  stats.turnsAccepted = 0;
  stats.turnsDuplicate = 0;
  stats.turnsSuppressedRepeat = 0;
  stats.turnsInterimDropped = 0;
  stats.bargeIns = 0;
  stats.generationsCoalesced = 0;
}

module.exports = {
  getCallRuntime,
  beginCallerTurn,
  recordRejectedInput,
  recordAuraTurn,
  markPlaybackSpeaking,
  markBargeIn,
  setBargeInListener,
  setCallLanguage,
  getCallLanguage,
  shouldResumeInterruptedResponse,
  mergeBookingInfo,
  setPendingQuestion,
  markQuestionAnswered,
  snapshotLedger,
  ledgerContextBlock,
  contextSummary,
  applyRepeatGuard,
  semanticSimilarity,
  rememberReplay,
  getReplay,
  runExclusiveTurn,
  getRuntimeStats,
  resetCallRuntime,
  resetAllCallRuntime,
  nextTurnId,
  hashTranscript,
  getTurn,
  getTurnByTwilioEvent,
  stashTurnInput,
  peekPendingInput,
  resolveTurnInput,
  isCallGreeted,
  markCallGreeted,
  conversationMessages,
  appendMessage,
  getBookingMachine,
  resetBookingMachine,
  recordTurnTrace,
  getTurnTraces,
  newAudioId,
  TRACE_FILE,
};
