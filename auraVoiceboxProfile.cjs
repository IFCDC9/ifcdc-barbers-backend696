/**
 * Voicebox engines / models / AURA ALLAH profile.
 * Uses only OpenAPI-discovered engines and preset lists. No cloning unless
 * Founder-approved samples already exist on the profile.
 */

const AURA_ALLAH_NAME = "AURA ALLAH";

const AURA_DESIGN_PROMPT =
  "A warm, soft, confident woman in her late twenties. Mature-youthful, conversational, never cartoonish, never caricature, never ethnic stereotype. Clear phone receptionist energy: kind, steady, and human.";

const AURA_PERSONALITY =
  "You are AURA Allah. Warm, soft, confident, conversational. Never caricature or stereotype. Same person in every language.";

/** Ranked multilingual candidates. Score only applies when the model is downloaded. */
const ENGINE_CANDIDATES = [
  { engine: "qwen", modelName: "qwen-tts-1.7B", modelSize: "1.7B", langs: ["en", "es", "he"], score: 100, multilingual: true },
  { engine: "qwen_custom_voice", modelName: "qwen-custom-voice-1.7B", modelSize: "1.7B", langs: ["en", "es", "he"], score: 94, multilingual: true },
  { engine: "tada", modelName: "tada-3b-ml", modelSize: "3B", langs: ["en", "es", "he"], score: 88, multilingual: true },
  { engine: "qwen", modelName: "qwen-tts-0.6B", modelSize: "0.6B", langs: ["en", "es", "he"], score: 78, multilingual: true },
  { engine: "qwen_custom_voice", modelName: "qwen-custom-voice-0.6B", modelSize: "0.6B", langs: ["en", "es", "he"], score: 72, multilingual: true },
  { engine: "chatterbox", modelName: "chatterbox-tts", modelSize: null, langs: ["en", "es", "he"], score: 66, multilingual: true },
  { engine: "kokoro", modelName: "kokoro", modelSize: null, langs: ["en", "es"], score: 40, multilingual: false },
  { engine: "luxtts", modelName: "luxtts", modelSize: null, langs: ["en"], score: 20, multilingual: false },
];

const KOKORO_CHARACTER_PRESET = "af_heart";
const QWEN_CUSTOM_CHARACTER_PRESET = "Serena";

function modelMap(status) {
  const list = Array.isArray(status?.models) ? status.models : [];
  const map = new Map();
  for (const m of list) map.set(String(m.model_name), m);
  return map;
}

function selectBestLocalEngine(modelsStatus, { preferredEngine = null } = {}) {
  const map = modelMap(modelsStatus);
  const downloaded = ENGINE_CANDIDATES.filter((c) => map.get(c.modelName)?.downloaded);
  const tested = downloaded.sort((a, b) => b.score - a.score);
  const bestTested = tested[0] || null;

  if (preferredEngine) {
    const forced = ENGINE_CANDIDATES.find((c) => c.engine === preferredEngine);
    if (forced) {
      const row = map.get(forced.modelName);
      return {
        ...forced,
        downloaded: Boolean(row?.downloaded),
        loaded: Boolean(row?.loaded),
        tested: Boolean(row?.downloaded),
        reason: row?.downloaded
          ? "VOICEBOX_ENGINE override (downloaded)"
          : "VOICEBOX_ENGINE override (not downloaded yet)",
      };
    }
  }

  if (bestTested) {
    const row = map.get(bestTested.modelName);
    return {
      ...bestTested,
      downloaded: true,
      loaded: Boolean(row?.loaded),
      tested: true,
      reason: bestTested.multilingual
        ? "strongest downloaded multilingual engine"
        : "only downloaded engine; Hebrew not in this engine's preset list",
    };
  }

  const qwen = ENGINE_CANDIDATES[0];
  return {
    ...qwen,
    downloaded: false,
    loaded: false,
    tested: false,
    reason: "no Voicebox TTS model downloaded; Qwen 1.7B is UI default but untested until download completes",
  };
}

function presetForEngine(engine) {
  if (engine === "kokoro") {
    return { preset_engine: "kokoro", preset_voice_id: KOKORO_CHARACTER_PRESET, voice_type: "preset" };
  }
  if (engine === "qwen_custom_voice") {
    return { preset_engine: "qwen_custom_voice", preset_voice_id: QWEN_CUSTOM_CHARACTER_PRESET, voice_type: "preset" };
  }
  return { preset_engine: engine || "qwen", preset_voice_id: null, voice_type: "designed" };
}

function auraAllahCreateBody(engineChoice) {
  const preset = presetForEngine(engineChoice.engine);
  return {
    name: AURA_ALLAH_NAME,
    description: "AURA Allah — IFCDC phone voice. Designed/preset, not cloned. Founder must approve any clone samples.",
    language: "en",
    voice_type: preset.voice_type,
    preset_engine: preset.preset_engine,
    preset_voice_id: preset.preset_voice_id,
    design_prompt: AURA_DESIGN_PROMPT,
    default_engine: engineChoice.engine,
    personality: AURA_PERSONALITY,
  };
}

function findAuraAllah(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.find((p) => String(p?.name || "").trim() === AURA_ALLAH_NAME) || null;
}

/**
 * Create AURA ALLAH if missing. Never converts a Founder clone into a preset.
 * Never uploads samples (no Founder-approved clone audio found).
 */
async function ensureAuraAllahProfile(client, engineChoice) {
  const profiles = await client.listProfiles();
  const existing = findAuraAllah(profiles);
  if (existing) {
    return { profile: existing, created: false };
  }
  const profile = await client.createProfile(auraAllahCreateBody(engineChoice));
  return { profile, created: true };
}

const SAMPLE_INSTRUCTS = {
  A: "Warm, soft, confident, conversational. Mature-youthful. Never cartoonish.",
  B: "Same woman, slightly brighter and clearer for a phone line, still warm.",
  C: "Same woman, calmer and unhurried, gentle confidence.",
  D: "Same woman, softer and closer, never a whisper caricature.",
  E: "Same woman, crisp diction for names and times, still warm and human.",
};

const SAMPLE_SENTENCE =
  "Hi, this is Aura Allah at Imperial Foundation C D C Barbers. I can help you book a haircut — just tell me the day and time that works.";

module.exports = {
  AURA_ALLAH_NAME,
  AURA_DESIGN_PROMPT,
  ENGINE_CANDIDATES,
  KOKORO_CHARACTER_PRESET,
  QWEN_CUSTOM_CHARACTER_PRESET,
  SAMPLE_INSTRUCTS,
  SAMPLE_SENTENCE,
  selectBestLocalEngine,
  presetForEngine,
  auraAllahCreateBody,
  findAuraAllah,
  ensureAuraAllahProfile,
};
