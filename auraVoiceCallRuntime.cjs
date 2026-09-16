/**
 * Per-call voice runtime: turn IDs, idempotency, in-call ledger, barge-in, repeat guard.
 * In-memory only (one Node process). Does not persist long-term user/business memory.
 */

const CAP = 2000;
const RECENT_AURA = 6;
const DEDUP_MS = 8000;

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {Map<string, Promise<{ twiml: string, turnId: string, reply: string }>>} */
const inflight = new Map();

const stats = {
  turnsAccepted: 0,
  turnsDuplicate: 0,
  turnsSuppressedRepeat: 0,
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

function createSession(callSid) {
  return {
    callSid,
    createdAt: now(),
    seq: 0,
    callerTurns: [],
    auraTurns: [],
    completedActions: [],
    booking: emptyBooking(),
    questionsAnswered: [],
    pendingQuestions: [],
    currentIntent: null,
    lastConfirmed: null,
    language: null,
    playback: { speaking: false, interrupted: false, interruptedTurnId: null },
    lastAcceptedTurnId: null,
    lastEventFingerprint: null,
    lastEventAt: 0,
    lastTwiml: "",
    lastReply: "",
    fingerprints: new Map(),
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
  return `${s.callSid || "anon"}:t${s.seq}:${now().toString(36)}`;
}

function normalizeFingerprint(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function eventFingerprint({ speech, digits, confidence }) {
  return [normalizeFingerprint(speech), String(digits || "").trim(), confidence == null ? "" : String(confidence)].join(
    "|",
  );
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

/** Semantic-ish overlap; not exact-string only. */
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

/**
 * Begin a caller turn. Duplicate transcripts / webhook retries reuse the same turnId.
 */
function beginCallerTurn(callSid, { speech = "", digits = "", confidence = null, source = "gather" } = {}) {
  const s = getCallRuntime(callSid);
  const fp = eventFingerprint({ speech, digits, confidence });
  const prev = s.fingerprints.get(fp);
  if (prev && now() - prev.at < DEDUP_MS) {
    if (s.lastTwiml && s.lastAcceptedTurnId === prev.turnId) {
      stats.turnsDuplicate += 1;
      return {
        accepted: false,
        duplicate: true,
        turnId: prev.turnId,
        eventId: prev.eventId,
        reason: "duplicate_transcript",
        replayTwiml: s.lastTwiml || "",
        replayReply: s.lastReply || "",
      };
    }
    return {
      accepted: true,
      duplicate: false,
      sameTurn: true,
      turnId: prev.turnId,
      eventId: prev.eventId,
      reason: "in_flight_same_turn",
    };
  }
  const turnId = nextTurnId(callSid);
  const eventId = `${turnId}:e`;
  s.fingerprints.set(fp, { turnId, eventId, at: now() });
  if (s.fingerprints.size > 80) {
    const first = s.fingerprints.keys().next().value;
    if (first !== undefined) s.fingerprints.delete(first);
  }
  s.lastEventFingerprint = fp;
  s.lastEventAt = now();
  s.lastAcceptedTurnId = turnId;
  s.playback.interrupted = false;
  stats.turnsAccepted += 1;
  s.callerTurns.push({
    turnId,
    eventId,
    text: String(speech || digits || "").slice(0, 500),
    confidence,
    source,
    at: now(),
    accepted: true,
  });
  if (s.callerTurns.length > 40) s.callerTurns.splice(0, s.callerTurns.length - 40);
  return { accepted: true, duplicate: false, turnId, eventId, reason: "new" };
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

function recordAuraTurn(callSid, { turnId, text, interrupted = false }) {
  const s = getCallRuntime(callSid);
  s.auraTurns.push({
    turnId: turnId || s.lastAcceptedTurnId,
    text: String(text || "").slice(0, 800),
    interrupted: Boolean(interrupted),
    at: now(),
  });
  if (s.auraTurns.length > 40) s.auraTurns.splice(0, s.auraTurns.length - 40);
  s.lastReply = String(text || "");
}

function markPlaybackSpeaking(callSid, speaking) {
  const s = getCallRuntime(callSid);
  s.playback.speaking = Boolean(speaking);
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
  s.playback.interruptedTurnId = turnId || s.lastAcceptedTurnId || s.auraTurns.at(-1)?.turnId || null;
  stats.bargeIns += 1;
  const last = s.auraTurns.at(-1);
  if (last) last.interrupted = true;
  try {
    if (bargeInListener) bargeInListener(callSid, s.playback.interruptedTurnId);
  } catch (e) {
    console.warn("[aura/runtime] barge-in listener:", e?.message || e);
  }
  return { interruptedTurnId: s.playback.interruptedTurnId, resumeOldResponse: false };
}

/**
 * Change spoken language for this call without resetting booking or ledger.
 */
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
    lastAcceptedTurnId: s.lastAcceptedTurnId,
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
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Before TTS: suppress/rewrite duplicate AURA lines that add no new info.
 */
function applyRepeatGuard(callSid, reply, { userText = "" } = {}) {
  const s = getCallRuntime(callSid);
  const text = String(reply || "").trim();
  if (!text) return { reply: text, suppressed: false, similarity: 0 };
  if (userAskedRepeat(userText)) return { reply: text, suppressed: false, similarity: 0, reason: "user_requested" };

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

function rememberReplay(callSid, { turnId, twiml, reply }) {
  const s = getCallRuntime(callSid);
  s.lastTwiml = String(twiml || "");
  s.lastReply = String(reply || "");
  if (turnId) s.lastAcceptedTurnId = turnId;
}

function getReplay(callSid) {
  const s = getCallRuntime(callSid);
  if (!s.lastTwiml) return null;
  return { twiml: s.lastTwiml, reply: s.lastReply, turnId: s.lastAcceptedTurnId };
}

/**
 * One primary generation per call at a time. Concurrent webhook retries await the first result.
 */
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
  stats.turnsAccepted = 0;
  stats.turnsDuplicate = 0;
  stats.turnsSuppressedRepeat = 0;
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
  applyRepeatGuard,
  semanticSimilarity,
  rememberReplay,
  getReplay,
  runExclusiveTurn,
  getRuntimeStats,
  resetCallRuntime,
  resetAllCallRuntime,
  nextTurnId,
};
