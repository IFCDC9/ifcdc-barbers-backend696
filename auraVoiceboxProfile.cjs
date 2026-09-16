/**
 * Voicebox engines / models / AURA ALLAH profile.
 * Founder-approved identity is Sample A (Kokoro af_heart). Qwen may be
 * downloaded on the Mac — it is NOT the approved speaker. Production live
 * calls stay Polly until VOICEBOX_PRIMARY=1 (default 0).
 */

const AURA_ALLAH_LEGACY_NAME = "AURA ALLAH";
const AURA_ALLAH_NAME = "AURA ALLAH — FOUNDER APPROVED V1";

const AURA_DESIGN_PROMPT =
  "A warm, soft, confident woman in her late twenties. Mature-youthful, conversational, never cartoonish, never caricature, never ethnic stereotype. Clear phone receptionist energy: kind, steady, and human.";

const AURA_PERSONALITY =
  "You are AURA Allah. Warm, soft, confident, conversational. Never caricature or stereotype. Same person in every language.";

/** Exact Sample A (round2) instruct. Do not shorten. */
const SAMPLE_A_INSTRUCT =
  "Warm, soft, confident, conversational. Mature-youthful. Never cartoonish or caricature.";

/** Phone-path extras. Identity remains Sample A; this only asks for call clarity. */
const SAMPLE_A_RUNTIME_EXTRAS =
  "Phone-call clarity. Natural pauses. Same woman; never cartoonish.";

const KOKORO_CHARACTER_PRESET = "af_heart";
const QWEN_CUSTOM_CHARACTER_PRESET = "Serena";

/**
 * Canonical Founder-approved voice. Source of truth in git.
 * Audio file stays outside git.
 */
const FOUNDER_APPROVED_VOICE = {
  sample: "A",
  round: "round2",
  version: "V1",
  name: AURA_ALLAH_NAME,
  engine: "kokoro",
  model: "kokoro",
  voiceId: KOKORO_CHARACTER_PRESET,
  language: "en",
  speed: 1.0,
  instruct: SAMPLE_A_INSTRUCT,
  voiceType: "preset",
  sourceFile: "~/Documents/ifcdc-aura-voice-samples/round2/aura-allah-A.wav",
  sourceSha256: "5422b11dbf91ba23581dc56ea43a494338ec2968b70f04967a5939d4806c16ce",
  productionActivation: "OFF",
  voiceboxPrimaryDefault: 0,
  fallback: "polly",
  approvedAt: "2026-09-16",
  note: "Founder approved Sample A as AURA voice direction. Test identity only. Production live calls remain Polly until Tessa sets VOICEBOX_PRIMARY=1.",
};

/** Ranked multilingual candidates (reference only — not the approved identity). */
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

const LANGUAGE_STATUS = {
  en: {
    code: "en",
    sameSpeaker: true,
    path: "voicebox_kokoro_af_heart",
    note: "Approved speaker. Kokoro af_heart.",
  },
  es: {
    code: "es",
    sameSpeaker: true,
    path: "voicebox_kokoro_af_heart",
    note: "Same Kokoro af_heart speaker speaking Spanish — closest same-person ES Kokoro allows (English-trained preset, not a native ES clone).",
  },
  he: {
    code: "he",
    sameSpeaker: false,
    path: "polly_fallback",
    note: "Kokoro has no Hebrew speaker identity. Live Kokoro HE is too slow for a Twilio webhook, so HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna until a faster same-speaker multilingual model is Founder-approved.",
  },
};

function modelMap(status) {
  const list = Array.isArray(status?.models) ? status.models : [];
  const map = new Map();
  for (const m of list) map.set(String(m.model_name), m);
  return map;
}

/** Always Kokoro af_heart — Founder-approved Sample A. Ignores Qwen even if downloaded. */
function selectCanonicalEngine(modelsStatus) {
  const map = modelMap(modelsStatus);
  const row = map.get("kokoro");
  return {
    engine: "kokoro",
    modelName: "kokoro",
    modelSize: null,
    langs: ["en", "es"],
    score: 40,
    multilingual: false,
    downloaded: Boolean(row?.downloaded),
    loaded: Boolean(row?.loaded),
    tested: Boolean(row?.downloaded),
    voiceId: KOKORO_CHARACTER_PRESET,
    reason:
      "Founder-approved Sample A (Kokoro af_heart). Other downloaded engines are not the approved identity.",
  };
}

function selectBestLocalEngine(modelsStatus, { preferredEngine = null } = {}) {
  if (!preferredEngine || preferredEngine === "kokoro") {
    return selectCanonicalEngine(modelsStatus);
  }
  const map = modelMap(modelsStatus);
  const forced = ENGINE_CANDIDATES.find((c) => c.engine === preferredEngine);
  if (forced) {
    const row = map.get(forced.modelName);
    return {
      ...forced,
      downloaded: Boolean(row?.downloaded),
      loaded: Boolean(row?.loaded),
      tested: Boolean(row?.downloaded),
      reason: row?.downloaded
        ? "VOICEBOX_ENGINE override (test-only; not Founder-approved identity)"
        : "VOICEBOX_ENGINE override (not downloaded yet)",
    };
  }
  return selectCanonicalEngine(modelsStatus);
}

function presetForEngine(engine) {
  if (engine === "kokoro") {
    return { preset_engine: "kokoro", preset_voice_id: KOKORO_CHARACTER_PRESET, voice_type: "preset" };
  }
  if (engine === "qwen_custom_voice") {
    return { preset_engine: "qwen_custom_voice", preset_voice_id: QWEN_CUSTOM_CHARACTER_PRESET, voice_type: "preset" };
  }
  return { preset_engine: engine || "kokoro", preset_voice_id: KOKORO_CHARACTER_PRESET, voice_type: "preset" };
}

function runtimeInstruct(emotionalTone, speed) {
  const bits = [SAMPLE_A_INSTRUCT, SAMPLE_A_RUNTIME_EXTRAS];
  const tone = String(emotionalTone || "").trim();
  if (tone && !/warm, soft, confident/i.test(tone)) bits.push(tone.slice(0, 120));
  const spd = String(speed || "").trim().toLowerCase();
  if (spd === "slow" || spd === "slower") bits.push("Unhurried pace.");
  else if (spd === "fast" || spd === "faster") bits.push("Slightly brisk, still clear.");
  else if (spd && Number(spd) > 0 && Number(spd) < 0.95) bits.push("Unhurried pace.");
  else if (spd && Number(spd) > 1.05) bits.push("Slightly brisk, still clear.");
  return bits.join(" ").slice(0, 500);
}

function auraAllahCreateBody(engineChoice) {
  void engineChoice;
  return {
    name: AURA_ALLAH_NAME,
    description:
      "AURA ALLAH — FOUNDER APPROVED V1. Sample A (round2) Kokoro af_heart. Test identity only. Production live calls stay Polly until VOICEBOX_PRIMARY=1.",
    language: "en",
    voice_type: "preset",
    preset_engine: "kokoro",
    preset_voice_id: KOKORO_CHARACTER_PRESET,
    design_prompt: AURA_DESIGN_PROMPT,
    default_engine: "kokoro",
    personality: AURA_PERSONALITY,
  };
}

function profileCreatePayload(engineChoice) {
  return auraAllahCreateBody(engineChoice);
}

function findAuraAllah(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return (
    list.find((p) => String(p?.name || "").trim() === AURA_ALLAH_NAME) ||
    null
  );
}

function profileNeedsSync(profile) {
  if (!profile) return true;
  if (String(profile.voice_type) === "cloned") return false;
  return (
    String(profile.preset_engine || "") !== "kokoro" ||
    String(profile.preset_voice_id || "") !== KOKORO_CHARACTER_PRESET ||
    String(profile.default_engine || "") !== "kokoro" ||
    String(profile.name || "").trim() !== AURA_ALLAH_NAME
  );
}

/**
 * Create the Founder-approved named profile if missing. Never converts a
 * Founder clone into a preset. Never uploads samples.
 */
async function ensureAuraAllahProfile(client, engineChoice) {
  const profiles = await client.listProfiles();
  const existing = findAuraAllah(profiles);
  if (existing && existing.voice_type === "cloned") {
    return { profile: existing, created: false, updated: false };
  }
  if (existing && !profileNeedsSync(existing)) {
    return { profile: existing, created: false, updated: false };
  }
  const payload = profileCreatePayload(engineChoice);
  if (existing && typeof client.updateProfile === "function") {
    const profile = await client.updateProfile(existing.id, payload);
    return { profile, created: false, updated: true };
  }
  const profile = await client.createProfile(payload);
  return { profile, created: true, updated: false };
}

const SAMPLE_INSTRUCTS = {
  A: SAMPLE_A_INSTRUCT,
  B: "Same woman, slightly brighter and clearer for a phone line, still warm.",
  C: "Same woman, calmer and unhurried, gentle confidence.",
  D: "Same woman, softer and closer, never a whisper caricature.",
  E: "Same woman, crisp diction for names and times, still warm and human.",
};

const SAMPLE_SENTENCE =
  "Hi, this is Aura Allah at Imperial Foundation C D C Barbers. I can help you book a haircut — just tell me the day and time that works.";

function heUsesPollyFallback() {
  return true;
}

module.exports = {
  AURA_ALLAH_NAME,
  AURA_ALLAH_LEGACY_NAME,
  AURA_DESIGN_PROMPT,
  AURA_PERSONALITY,
  ENGINE_CANDIDATES,
  FOUNDER_APPROVED_VOICE,
  KOKORO_CHARACTER_PRESET,
  LANGUAGE_STATUS,
  QWEN_CUSTOM_CHARACTER_PRESET,
  SAMPLE_A_INSTRUCT,
  SAMPLE_A_RUNTIME_EXTRAS,
  SAMPLE_INSTRUCTS,
  SAMPLE_SENTENCE,
  selectBestLocalEngine,
  selectCanonicalEngine,
  presetForEngine,
  runtimeInstruct,
  auraAllahCreateBody,
  profileCreatePayload,
  findAuraAllah,
  ensureAuraAllahProfile,
  heUsesPollyFallback,
};
