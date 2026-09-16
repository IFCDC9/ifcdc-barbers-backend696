/**
 * Persistent AURA voice lessons + Founder-correctable pronunciation extras.
 * File-backed (no production schema change). Lost only if the host disk is wiped.
 */

const fs = require("fs");
const path = require("path");
const { FOUNDER_APPROVED_VOICE, LANGUAGE_STATUS, SAMPLE_A_INSTRUCT } = require("./auraVoiceboxProfile.cjs");

const DEFAULT_PATH = path.join(__dirname, "data", "aura-voice-memory.json");

function memoryPath() {
  const override = String(process.env.AURA_VOICE_MEMORY_PATH || "").trim();
  return override || DEFAULT_PATH;
}

function canonicalFounderApproved(extra = {}) {
  return {
    ...FOUNDER_APPROVED_VOICE,
    instruct: SAMPLE_A_INSTRUCT,
    languages: LANGUAGE_STATUS,
    productionActivation: "OFF",
    voiceboxPrimary: 0,
    profileId: extra.profileId || extra.profile_id || FOUNDER_APPROVED_VOICE.profileId || null,
    profileName: extra.profileName || FOUNDER_APPROVED_VOICE.name,
    customerFacingName: FOUNDER_APPROVED_VOICE.customerFacingName || "Aura",
    voiceId: FOUNDER_APPROVED_VOICE.voiceId,
    persistedAt: extra.persistedAt || null,
  };
}

function emptyStore() {
  return {
    version: 3,
    pronunciations: [],
    lessons: [],
    lastLesson: null,
    updatedAt: null,
    founderApprovedVoice: canonicalFounderApproved(),
    latencies: {},
    lastTest: null,
  };
}

function readStore() {
  try {
    const raw = fs.readFileSync(memoryPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return {
      ...emptyStore(),
      ...parsed,
      pronunciations: Array.isArray(parsed.pronunciations) ? parsed.pronunciations : [],
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      latencies: parsed.latencies && typeof parsed.latencies === "object" ? parsed.latencies : {},
      lastTest: parsed.lastTest && typeof parsed.lastTest === "object" ? parsed.lastTest : null,
      founderApprovedVoice: canonicalFounderApproved(parsed.founderApprovedVoice || {}),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const file = memoryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...emptyStore(), ...store, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function listPronunciations() {
  return readStore().pronunciations;
}

function upsertPronunciation({ id, from, to, note } = {}) {
  const term = String(from || "").trim();
  const speak = String(to || "").trim();
  if (!term || !speak) {
    throw new Error("pronunciation requires from and to");
  }
  const store = readStore();
  const key = String(id || term).trim();
  const row = { id: key, from: term, to: speak, note: String(note || "").trim() || null, at: new Date().toISOString() };
  const idx = store.pronunciations.findIndex((p) => String(p.id) === key || String(p.from).toLowerCase() === term.toLowerCase());
  if (idx >= 0) store.pronunciations[idx] = { ...store.pronunciations[idx], ...row };
  else store.pronunciations.push(row);
  writeStore(store);
  return row;
}

function addLesson(text, { source = "founder" } = {}) {
  const body = String(text || "").trim();
  if (!body) throw new Error("lesson text required");
  const store = readStore();
  const lesson = {
    id: `lesson_${Date.now().toString(36)}`,
    text: body.slice(0, 2000),
    source: String(source || "founder"),
    at: new Date().toISOString(),
  };
  store.lessons.push(lesson);
  if (store.lessons.length > 200) store.lessons.splice(0, store.lessons.length - 200);
  store.lastLesson = lesson;
  writeStore(store);
  return lesson;
}

function getLastLesson() {
  return readStore().lastLesson;
}

function persistFounderApprovedVoice(extra = {}) {
  const store = readStore();
  const prev = store.founderApprovedVoice || {};
  const next = canonicalFounderApproved({
    ...prev,
    ...extra,
  });
  const { persistedAt: prevAt, ...prevRest } = prev;
  const { persistedAt: _nextAt, ...nextRest } = next;
  void _nextAt;
  if (JSON.stringify(prevRest) === JSON.stringify(nextRest)) {
    if (!prevAt) {
      next.persistedAt = new Date().toISOString();
      store.founderApprovedVoice = next;
      writeStore(store);
      return next;
    }
    return prev;
  }
  next.persistedAt = new Date().toISOString();
  store.founderApprovedVoice = next;
  writeStore(store);
  return next;
}

function getFounderApprovedVoice() {
  const store = readStore();
  return canonicalFounderApproved(store.founderApprovedVoice || {});
}

function persistLatencySample(partial = {}) {
  const language = String(partial.language || "en").toLowerCase().split(/[-_]/)[0] || "en";
  const model = String(partial.model || partial.engine || "kokoro").trim() || "kokoro";
  const store = readStore();
  if (!store.latencies || typeof store.latencies !== "object") store.latencies = {};
  if (!store.latencies[language]) store.latencies[language] = {};
  if (!store.latencies[language][model]) store.latencies[language][model] = { samples: [], last: null };
  const row = {
    firstByteMs: numOrNull(partial.firstByteMs),
    firstPhraseMs: numOrNull(partial.firstPhraseMs),
    totalMs: numOrNull(partial.totalMs ?? partial.totalSynthMs),
    rtf: numOrNull(partial.rtf),
    interruptMs: numOrNull(partial.interruptMs),
    recoveryMs: numOrNull(partial.recoveryMs),
    fallbackMs: numOrNull(partial.fallbackMs),
    at: new Date().toISOString(),
  };
  const bucket = store.latencies[language][model];
  bucket.samples.push(row);
  while (bucket.samples.length > 20) bucket.samples.shift();
  bucket.last = row;
  writeStore(store);
  return row;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function persistLastTest(row) {
  const store = readStore();
  store.lastTest = row && typeof row === "object" ? { ...row, at: row.at || new Date().toISOString() } : null;
  writeStore(store);
  return store.lastTest;
}

function getLatencies() {
  return readStore().latencies || {};
}

function getPersistedLastTest() {
  return readStore().lastTest || null;
}

function getVoiceMemorySnapshot() {
  const approved = persistFounderApprovedVoice();
  const store = readStore();
  return {
    pronunciationCount: store.pronunciations.length,
    lessonCount: store.lessons.length,
    lastLesson: store.lastLesson,
    pronunciations: store.pronunciations,
    founderApprovedVoice: approved,
    latencies: store.latencies || {},
    lastTest: store.lastTest || null,
    updatedAt: store.updatedAt,
    path: memoryPath(),
  };
}

try {
  persistFounderApprovedVoice();
} catch {
  /* disk may be read-only in some test sandboxes */
}

module.exports = {
  memoryPath,
  readStore,
  listPronunciations,
  upsertPronunciation,
  addLesson,
  getLastLesson,
  getVoiceMemorySnapshot,
  persistFounderApprovedVoice,
  getFounderApprovedVoice,
  canonicalFounderApproved,
  persistLatencySample,
  persistLastTest,
  getLatencies,
  getPersistedLastTest,
};
