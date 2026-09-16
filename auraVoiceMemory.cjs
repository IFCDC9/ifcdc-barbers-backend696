/**
 * Persistent AURA voice lessons + Founder-correctable pronunciation extras.
 * File-backed (no production schema change). Lost only if the host disk is wiped.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join(__dirname, "data", "aura-voice-memory.json");

function memoryPath() {
  const override = String(process.env.AURA_VOICE_MEMORY_PATH || "").trim();
  return override || DEFAULT_PATH;
}

function emptyStore() {
  return {
    version: 1,
    pronunciations: [],
    lessons: [],
    lastLesson: null,
    updatedAt: null,
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

function getVoiceMemorySnapshot() {
  const store = readStore();
  return {
    pronunciationCount: store.pronunciations.length,
    lessonCount: store.lessons.length,
    lastLesson: store.lastLesson,
    pronunciations: store.pronunciations,
    updatedAt: store.updatedAt,
    path: memoryPath(),
  };
}

module.exports = {
  memoryPath,
  readStore,
  listPronunciations,
  upsertPronunciation,
  addLesson,
  getLastLesson,
  getVoiceMemorySnapshot,
};
