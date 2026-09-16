/**
 * AURA ↔ Voicebox speech bridge.
 * Architecture: CALL → AURA intelligence → booking logic → language decision → Voicebox → speech.
 * Voicebox is parallel TTS. On crash/timeout/invalid audio → automatic Polly/Say fallback.
 * Never drops a call. Never books. Never replaces AURA brain.
 */

const { isVoiceboxPrimary, voiceboxFlags } = require("./auraVoiceboxFlags.cjs");
const { createVoiceboxClient } = require("./auraVoiceboxClient.cjs");
const {
  AURA_ALLAH_NAME,
  AURA_PUBLIC_NAME,
  FOUNDER_APPROVED_VOICE,
  LANGUAGE_STATUS,
  SAMPLE_A_INSTRUCT,
  selectCanonicalEngine,
  ensureAuraAllahProfile,
  findAuraAllah,
  runtimeInstruct,
  heUsesPollyFallback,
  selectLanguageRoute,
} = require("./auraVoiceboxProfile.cjs");
const { prepareSpokenText } = require("./auraVoicePronunciation.cjs");
const {
  listPronunciations,
  getLastLesson,
  getVoiceMemorySnapshot,
  persistFounderApprovedVoice,
  persistLatencySample,
  getPersistedLastTest,
} = require("./auraVoiceMemory.cjs");
const { isPipecatEnabled } = require("./auraPipecatFlags.cjs");
const {
  splitForStreaming,
  storePendingRest,
  takePendingRest,
  getPendingRest,
  recordStreamMetrics,
  rtfFor,
  getPipecatHqStatus,
  getPipelineHealth,
  getLastTest,
  setLastTest,
  twilioHqStatus,
  pollyHqStatus,
} = require("./auraPipecatPipeline.cjs");

const MAX_CACHE = 40;
const audioCache = new Map();

const stats = {
  speaks: 0,
  fallbacks: 0,
  timeouts: 0,
  invalidAudio: 0,
  cancels: 0,
  lastLatencyMs: null,
  lastFirstByteMs: null,
  lastTotalMs: null,
  lastFirstPhraseMs: null,
  lastFallbackReason: null,
  lastEngine: null,
  lastProfileId: null,
  lastLanguage: null,
  lastError: null,
  lastOkAt: null,
};

let clientOverride = null;
let profileCache = { at: 0, profile: null, engine: null };
let healthCache = { at: 0, value: null };
const queues = new Map();
const inflightByConversation = new Map();
const abortByConversation = new Map();
const cancelFlags = new Map();

function getClient() {
  return clientOverride || createVoiceboxClient();
}

function setVoiceboxClientForTests(client) {
  clientOverride = client || null;
  healthCache = { at: 0, value: null };
  profileCache = { at: 0, profile: null, engine: null };
}

function resetVoiceboxBridgeForTests() {
  clientOverride = null;
  healthCache = { at: 0, value: null };
  profileCache = { at: 0, profile: null, engine: null };
  queues.clear();
  inflightByConversation.clear();
  abortByConversation.clear();
  cancelFlags.clear();
  audioCache.clear();
  stats.speaks = 0;
  stats.fallbacks = 0;
  stats.timeouts = 0;
  stats.invalidAudio = 0;
  stats.cancels = 0;
  stats.lastLatencyMs = null;
  stats.lastFirstByteMs = null;
  stats.lastTotalMs = null;
  stats.lastFirstPhraseMs = null;
  stats.lastFallbackReason = null;
  stats.lastEngine = null;
  stats.lastProfileId = null;
  stats.lastLanguage = null;
  stats.lastError = null;
  stats.lastOkAt = null;
}

function isValidAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE") return true;
  if (buf.slice(0, 3).toString("ascii") === "ID3") return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

function cacheAudio(id, buffer, contentType) {
  while (audioCache.size >= MAX_CACHE) {
    const first = audioCache.keys().next().value;
    if (first === undefined) break;
    audioCache.delete(first);
  }
  audioCache.set(id, { buffer, contentType: contentType || "audio/wav", at: Date.now() });
}

function getCachedAudio(id) {
  return audioCache.get(id) || null;
}

function mapLanguage(language) {
  const s = String(language || "en").toLowerCase().split(/[-_]/)[0];
  const allowed = new Set([
    "zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it", "he", "ar",
    "da", "el", "fi", "hi", "ms", "nl", "no", "pl", "sv", "sw", "tr",
  ]);
  if (s === "iw") return "he";
  return allowed.has(s) ? s : "en";
}

function instructFromTone(emotionalTone, speed) {
  return runtimeInstruct(emotionalTone, speed);
}

/** Keep punctuation pauses; do not rewrite booking copy. */
function applyPhonePauses(text) {
  return String(text || "")
    .replace(/\s+[–—]\s+/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function probeHealth(force = false) {
  const flags = voiceboxFlags();
  const now = Date.now();
  if (!force && healthCache.value && now - healthCache.at < flags.healthTtlMs) return healthCache.value;
  try {
    const health = await getClient().health(flags.healthTimeoutMs);
    const value = {
      ok: String(health?.status || "").toLowerCase() === "healthy",
      reachable: true,
      health,
      error: null,
    };
    healthCache = { at: now, value };
    return value;
  } catch (e) {
    const value = { ok: false, reachable: false, health: null, error: String(e?.message || e).slice(0, 180) };
    healthCache = { at: now, value };
    return value;
  }
}

async function resolveEngineAndProfile() {
  const now = Date.now();
  if (profileCache.profile && now - profileCache.at < 30_000) {
    return { profile: profileCache.profile, engine: profileCache.engine };
  }
  const client = getClient();
  const flags = voiceboxFlags();
  let models = { models: [] };
  try {
    models = await client.modelsStatus();
  } catch (e) {
    console.warn("[aura/voicebox] models/status failed:", e?.message || e);
  }
  void flags;
  const engine = selectCanonicalEngine(models);
  const { profile } = await ensureAuraAllahProfile(client, engine);
  if (profile?.id) {
    persistFounderApprovedVoice({
      profileId: profile.id,
      profileName: profile.name,
      voiceId: profile.preset_voice_id || FOUNDER_APPROVED_VOICE.voiceId,
    });
  }
  profileCache = { at: now, profile, engine };
  return { profile, engine };
}

function enqueue(conversationId, fn) {
  const key = String(conversationId || "__default__");
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tracked = next.catch(() => {}).finally(() => {
    if (queues.get(key) === tracked) queues.delete(key);
  });
  queues.set(key, tracked);
  return next;
}

async function waitForGeneration(client, id, timeoutMs, conversationId) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conversationId && cancelFlags.get(conversationId)) {
      const err = new Error("cancelled");
      err.code = "cancelled";
      throw err;
    }
    let row = null;
    try {
      row = await client.getHistory(id);
    } catch {
      try {
        const sse = await client.generationStatus(id);
        if (sse && typeof sse === "object" && sse.status) row = sse;
      } catch {
        row = null;
      }
    }
    const status = String(row?.status || "").toLowerCase();
    if (status === "completed" || row?.audio_path) return row;
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      const err = new Error(row?.error || `generation_${status || "failed"}`);
      err.generation = row;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const err = new Error("voicebox_timeout");
  err.code = "timeout";
  throw err;
}

async function synthesizeOnce(args) {
  const client = getClient();
  const flags = voiceboxFlags();
  const { profile, engine } = await resolveEngineAndProfile();
  const language = mapLanguage(args.language);
  const spoken = applyPhonePauses(prepareSpokenText(args.text, { language, extras: listPronunciations() }));
  const body = {
    profile_id: profile.id,
    text: spoken,
    language,
    engine: "kokoro",
    instruct: instructFromTone(args.emotionalTone || SAMPLE_A_INSTRUCT, args.speed || FOUNDER_APPROVED_VOICE.speed),
    personality: false,
    max_chunk_chars: flags.maxChunkChars || 120,
    crossfade_ms: flags.crossfadeMs ?? 40,
    normalize: true,
  };
  if (engine.modelSize) body.model_size = engine.modelSize;

  const conversationId = String(args.conversationId || "");
  cancelFlags.delete(conversationId);
  let generationId = null;

  const track = (id) => {
    generationId = id;
    if (conversationId && id) inflightByConversation.set(conversationId, id);
  };

  try {
    if (flags.stream) {
      try {
        const streamFn = client.generateStreamMeta || client.generateStream;
        const streamed = await streamFn.call(client, body, flags.timeoutMs, {
          onAbort: (fn) => {
            if (conversationId) abortByConversation.set(conversationId, fn);
          },
        });
        if (isValidAudio(streamed.buffer)) {
          const id = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          cacheAudio(id, streamed.buffer, streamed.contentType);
          return {
            ok: true,
            fallback: false,
            generationId: id,
            audio: streamed.buffer,
            contentType: streamed.contentType || "audio/wav",
            language,
            engine: engine.engine,
            model: engine.modelName,
            profileId: profile.id,
            profileName: profile.name,
            spokenText: spoken,
            firstByteMs: streamed.firstByteMs ?? null,
            totalMs: streamed.totalMs ?? null,
          };
        }
        stats.invalidAudio += 1;
        throw new Error("invalid_audio");
      } catch (streamErr) {
        if (conversationId && cancelFlags.get(conversationId)) {
          const err = new Error("cancelled");
          err.code = "cancelled";
          throw err;
        }
        if (String(streamErr?.message || "") === "invalid_audio") throw streamErr;
        console.warn("[aura/voicebox] stream failed; trying /generate:", streamErr?.message || streamErr);
      }
    }

    const gen = await client.generate(body);
    track(gen?.id);
    const done =
      String(gen?.status || "").toLowerCase() === "completed" && gen?.id
        ? gen
        : await waitForGeneration(client, gen.id, flags.timeoutMs, conversationId);
    const audio = await client.getAudio(done.id, flags.timeoutMs);
    if (!isValidAudio(audio.buffer)) {
      stats.invalidAudio += 1;
      throw new Error("invalid_audio");
    }
    cacheAudio(done.id, audio.buffer, audio.contentType);
    return {
      ok: true,
      fallback: false,
      generationId: done.id,
      audio: audio.buffer,
      contentType: audio.contentType || "audio/wav",
      language,
      engine: engine.engine,
      model: engine.modelName,
      profileId: profile.id,
      profileName: profile.name,
      spokenText: spoken,
    };
  } finally {
    if (conversationId) abortByConversation.delete(conversationId);
    if (conversationId && inflightByConversation.get(conversationId) === generationId) {
      inflightByConversation.delete(conversationId);
    }
  }
}

function recordFallback(reason, err) {
  stats.fallbacks += 1;
  stats.lastFallbackReason = reason;
  stats.lastError = String(err?.message || err || reason).slice(0, 180);
  if (reason === "timeout" || err?.code === "timeout") stats.timeouts += 1;
  console.warn("[aura/voicebox] fallback", reason, stats.lastError);
}

/**
 * speak({text, language, voiceProfile, emotionalTone, speed, conversationId})
 * Maps onto Voicebox POST /generate or POST /generate/stream.
 */
async function speak(opts = {}) {
  const started = Date.now();
  stats.speaks += 1;
  const text = String(opts.text || "").trim();
  if (!text) {
    recordFallback("empty_text");
    return { ok: false, fallback: true, reason: "empty_text" };
  }

  const health = await probeHealth();
  if (!health.reachable || !health.ok) {
    recordFallback("unhealthy", health.error);
    return { ok: false, fallback: true, reason: "unhealthy", error: health.error };
  }

  const language = mapLanguage(opts.language);
  const flags = voiceboxFlags();
  if (language === "he" && heUsesPollyFallback() && flags.hePollyFallback && !opts.allowSlowHebrew) {
    recordFallback("hebrew_kokoro_too_slow");
    stats.lastLanguage = "he";
    stats.lastLatencyMs = Date.now() - started;
    return {
      ok: false,
      fallback: true,
      reason: "hebrew_kokoro_too_slow",
      language: "he",
      note: LANGUAGE_STATUS.he.note,
    };
  }

  const conversationId = String(opts.conversationId || opts.voiceProfile || "default");
  try {
    const result = await enqueue(conversationId, () => synthesizeOnce({ ...opts, conversationId, language }));
    stats.lastLatencyMs = Date.now() - started;
    stats.lastFirstByteMs = result.firstByteMs ?? stats.lastLatencyMs;
    stats.lastTotalMs = result.totalMs ?? stats.lastLatencyMs;
    stats.lastFirstPhraseMs = result.firstPhraseMs ?? stats.lastFirstByteMs;
    stats.lastEngine = result.engine;
    stats.lastProfileId = result.profileId;
    stats.lastLanguage = result.language;
    stats.lastOkAt = new Date().toISOString();
    stats.lastFallbackReason = null;
    stats.lastError = null;
    try {
      persistLatencySample({
        language: result.language,
        model: result.model || result.engine,
        firstByteMs: stats.lastFirstByteMs,
        firstPhraseMs: stats.lastFirstPhraseMs,
        totalMs: stats.lastTotalMs,
        rtf: rtfFor(result.audio, stats.lastTotalMs),
      });
    } catch {
      /* memory file may be read-only */
    }
    console.log("[aura/voicebox] speak ok", {
      ms: stats.lastLatencyMs,
      firstByteMs: stats.lastFirstByteMs,
      engine: result.engine,
      language: result.language,
      generationId: result.generationId,
      bytes: result.audio?.length || 0,
    });
    return result;
  } catch (e) {
    const reason = e?.code === "timeout" || String(e?.message || "").includes("timeout") ? "timeout" : "error";
    recordFallback(reason, e);
    stats.lastLatencyMs = Date.now() - started;
    return { ok: false, fallback: true, reason, error: String(e?.message || e).slice(0, 180) };
  }
}

/**
 * Pipecat streaming speak: first complete phrase (e.g. "Absolutely...") is
 * synthesized and returned without waiting for the rest of a long booking
 * line. Rest continues in the background. Gated by PIPECAT_ENABLED for the
 * Twilio Play path; tests may call this directly.
 */
async function speakStreaming(opts = {}) {
  const started = Date.now();
  const language = mapLanguage(opts.language);
  const split = splitForStreaming(opts.text, language);

  if (split.unchunked || !split.rest) {
    const one = await speak({ ...opts, language });
    const firstPhraseMs = Date.now() - started;
    const ttfbMs = one.firstByteMs ?? firstPhraseMs;
    recordStreamMetrics({
      ttfbMs,
      firstPhraseMs,
      totalSynthMs: one.totalMs ?? firstPhraseMs,
      rtf: rtfFor(one.audio, one.totalMs ?? firstPhraseMs),
      language,
    });
    return {
      ok: Boolean(one.ok),
      fallback: Boolean(one.fallback),
      unchunked: true,
      reason: split.reason,
      first: one,
      rest: null,
      restPromise: Promise.resolve(null),
      ttfbMs,
      firstPhraseMs,
      totalSynthMs: one.totalMs ?? firstPhraseMs,
      rtf: rtfFor(one.audio, one.totalMs ?? firstPhraseMs),
      language,
      firstText: split.first,
      restText: "",
    };
  }

  const first = await speak({
    ...opts,
    text: split.first,
    language,
    conversationId: `${opts.conversationId || "stream"}:first`,
  });
  const firstPhraseMs = Date.now() - started;
  const ttfbMs = first.firstByteMs ?? firstPhraseMs;
  recordStreamMetrics({ ttfbMs, firstPhraseMs, language });

  const restPromise = speak({
    ...opts,
    text: split.rest,
    language,
    conversationId: `${opts.conversationId || "stream"}:rest`,
  }).then((rest) => {
    const totalSynthMs = Date.now() - started;
    const rtf = rtfFor(rest?.audio, rest?.totalMs ?? totalSynthMs);
    recordStreamMetrics({ totalSynthMs, rtf, language });
    try {
      persistLatencySample({
        language,
        model: rest?.model || first.model || "kokoro",
        firstByteMs: ttfbMs,
        firstPhraseMs,
        totalMs: totalSynthMs,
        rtf,
      });
    } catch {
      /* ignore */
    }
    return rest;
  });

  const token = `pc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  storePendingRest(token, {
    conversationId: String(opts.conversationId || ""),
    language,
    restPromise,
    first,
    gatherAction: opts.gatherAction || null,
  });

  return {
    ok: Boolean(first.ok),
    fallback: Boolean(first.fallback),
    unchunked: false,
    reason: split.reason,
    first,
    rest: null,
    restPromise,
    continueToken: token,
    ttfbMs,
    firstPhraseMs,
    totalSynthMs: null,
    language,
    firstText: split.first,
    restText: split.rest,
  };
}

async function cancelSpeak(conversationId) {
  const key = String(conversationId || "");
  cancelFlags.set(key, true);
  const abort = abortByConversation.get(key);
  if (typeof abort === "function") {
    try {
      abort();
    } catch {
      /* ignore */
    }
  }
  const id = inflightByConversation.get(key);
  if (!id) return { cancelled: Boolean(abort) };
  stats.cancels += 1;
  inflightByConversation.delete(key);
  try {
    if (!String(id).startsWith("stream_")) await getClient().cancelGeneration(id);
  } catch (e) {
    console.warn("[aura/voicebox] cancel failed:", e?.message || e);
  }
  return { cancelled: true, generationId: id };
}

function publicAudioUrl(generationId) {
  const base = String(process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (!base || !generationId) return null;
  if (/localhost|127\.0\.0\.1/i.test(base)) return null;
  return `${base}/api/aura/voicebox/audio/${encodeURIComponent(generationId)}`;
}

/**
 * For Twilio Gather: try Voicebox Play URL when VOICEBOX_PRIMARY=1.
 * Always returns fallback:true + no url when primary is off or synthesis fails.
 */
async function tryVoiceboxPlayUrl(opts = {}) {
  if (!isVoiceboxPrimary()) return { used: false, url: null, reason: "primary_off" };
  if (mapLanguage(opts.language) === "he" && heUsesPollyFallback()) {
    return { used: false, url: null, reason: "hebrew_kokoro_too_slow", fallback: true };
  }
  if (isPipecatEnabled()) {
    const streamed = await speakStreaming(opts);
    if (!streamed.ok || !streamed.first?.generationId) {
      return { used: false, url: null, reason: streamed.first?.reason || streamed.reason || "speak_failed", fallback: true };
    }
    const firstUrl = publicAudioUrl(streamed.first.generationId);
    if (!firstUrl) {
      recordFallback("no_public_audio_url");
      return {
        used: false,
        url: null,
        reason: "no_public_audio_url",
        fallback: true,
        generationId: streamed.first.generationId,
      };
    }
    if (streamed.unchunked || !streamed.continueToken) {
      return {
        used: true,
        url: firstUrl,
        urls: [firstUrl],
        generationId: streamed.first.generationId,
        latencyMs: streamed.firstPhraseMs,
        firstPhraseMs: streamed.firstPhraseMs,
        ttfbMs: streamed.ttfbMs,
      };
    }
    const continueUrl = publicContinueUrl(streamed.continueToken, opts);
    return {
      used: true,
      url: firstUrl,
      urls: [firstUrl],
      continueUrl,
      continueToken: streamed.continueToken,
      generationId: streamed.first.generationId,
      latencyMs: streamed.firstPhraseMs,
      firstPhraseMs: streamed.firstPhraseMs,
      ttfbMs: streamed.ttfbMs,
      streaming: true,
    };
  }
  const result = await speak(opts);
  if (!result.ok || !result.generationId) {
    return { used: false, url: null, reason: result.reason || "speak_failed", fallback: true };
  }
  const url = publicAudioUrl(result.generationId);
  if (!url) {
    recordFallback("no_public_audio_url");
    return { used: false, url: null, reason: "no_public_audio_url", fallback: true, generationId: result.generationId };
  }
  return { used: true, url, generationId: result.generationId, latencyMs: stats.lastLatencyMs };
}

function publicContinueUrl(token, opts = {}) {
  const base = String(process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (!base || !token) return null;
  if (/localhost|127\.0\.0\.1/i.test(base)) return null;
  const qs = new URLSearchParams();
  if (opts.gatherAction) qs.set("gather", String(opts.gatherAction));
  if (opts.language) qs.set("language", String(opts.language));
  if (opts.conversationId) qs.set("callSid", String(opts.conversationId));
  const q = qs.toString();
  return `${base}/api/aura/voicebox/continue/${encodeURIComponent(token)}${q ? `?${q}` : ""}`;
}

async function getVoiceboxHqStatus() {
  const flags = voiceboxFlags();
  const health = await probeHealth();
  let models = { models: [] };
  let profiles = [];
  try {
    if (health.reachable) {
      models = await getClient().modelsStatus();
      profiles = await getClient().listProfiles();
    }
  } catch (e) {
    console.warn("[aura/voicebox] hq status extras:", e?.message || e);
  }
  const engine = selectCanonicalEngine(models);
  const profile = findAuraAllah(profiles) || profileCache.profile || null;
  if (profile?.id) {
    persistFounderApprovedVoice({
      profileId: profile.id,
      profileName: profile.name,
      voiceId: profile.preset_voice_id || FOUNDER_APPROVED_VOICE.voiceId,
    });
  }
  const mem = getVoiceMemorySnapshot();
  const approved = mem.founderApprovedVoice || FOUNDER_APPROVED_VOICE;
  let pipecat = null;
  try {
    pipecat = await getPipecatHqStatus();
  } catch (e) {
    pipecat = { status: "ERROR", error: String(e?.message || e).slice(0, 120) };
  }
  const twilio = twilioHqStatus();
  const polly = pollyHqStatus();
  const persistedTest = mem.lastTest || getLastTest() || getPersistedLastTest();
  const hq = {
    status: !health.reachable ? "DOWN" : health.ok ? (flags.primary ? "PRIMARY" : "STANDBY") : "UNHEALTHY",
    primary: flags.primary,
    productionActivation: "OFF",
    reachable: health.reachable,
    modelLoaded: Boolean(health.health?.model_loaded),
    model: engine.modelName,
    engine: engine.engine,
    engineReason: engine.reason,
    engineTested: engine.tested,
    engineDownloaded: engine.downloaded,
    profile: profile?.name || flags.profileName,
    profileId: profile?.id || stats.lastProfileId || approved.profileId || null,
    voiceType: profile?.voice_type || "preset",
    language: stats.lastLanguage || "en",
    latencyMs: stats.lastLatencyMs,
    firstByteMs: stats.lastFirstByteMs,
    firstPhraseMs: stats.lastFirstPhraseMs,
    totalMs: stats.lastTotalMs,
    latencies: mem.latencies || {},
    fallback: stats.lastFallbackReason || "polly",
    lastLesson: getLastLesson(),
    lastTest: persistedTest,
    lastError: stats.lastError,
    publicName: AURA_PUBLIC_NAME,
    gpu: health.health
      ? { available: health.health.gpu_available, backend: health.health.backend_type, variant: health.health.backend_variant }
      : null,
    baseUrl: flags.baseUrl,
    memory: {
      pronunciationCount: mem.pronunciationCount,
      lessonCount: mem.lessonCount,
      lastLesson: mem.lastLesson,
      founderApprovedVoice: approved,
      latencies: mem.latencies || {},
      lastTest: persistedTest,
    },
    founderApproved: {
      sample: "A",
      voiceId: FOUNDER_APPROVED_VOICE.voiceId,
      engine: "kokoro",
      model: "kokoro",
      profileName: AURA_ALLAH_NAME,
      customerFacingName: AURA_PUBLIC_NAME,
      publicName: AURA_PUBLIC_NAME,
      profileId: profile?.id || approved.profileId || null,
      instruct: SAMPLE_A_INSTRUCT,
      speed: 1.0,
      productionActivation: "OFF",
    },
    activeTestModel: {
      engine: engine.engine,
      model: engine.modelName,
      voiceId: FOUNDER_APPROVED_VOICE.voiceId,
      downloaded: engine.downloaded,
      loaded: engine.loaded,
    },
    languages: LANGUAGE_STATUS,
    pipecat,
    twilio,
    polly,
    stats: { ...stats },
    enablement:
      "Tessa later: (1) PIPECAT_ENABLED=1 on the Founder Mac with Voicebox + optional `python3 tools/pipecat/sidecar.py`. (2) VOICEBOX_PRIMARY=1 only on a host that can reach Voicebox. Leave both 0 on Render until a private tunnel exists. Polly remains production primary. Sample A is the test identity only.",
    tunnel:
      "Render cannot reach 127.0.0.1 on the Founder Mac. To try primary from Render, run a private tunnel and set VOICEBOX_BASE_URL to that URL. Default path is local/HQ + Polly fallback.",
  };
  hq.pipelineHealth = getPipelineHealth({
    voicebox: hq,
    pipecat,
    twilio,
    polly,
  });
  return hq;
}

let prewarmPromise = null;
async function prewarmVoicebox() {
  if (prewarmPromise) return prewarmPromise;
  prewarmPromise = (async () => {
    const health = await probeHealth(true);
    if (!health.ok) return { ok: false, reason: "unhealthy", error: health.error };
    const started = Date.now();
    const result = await speak({ text: "Hi.", language: "en", conversationId: "__prewarm__" });
    return {
      ok: Boolean(result.ok),
      ms: Date.now() - started,
      firstByteMs: result.firstByteMs ?? null,
      fallback: result.fallback || false,
    };
  })().catch((e) => ({ ok: false, reason: "prewarm_error", error: String(e?.message || e).slice(0, 180) }));
  return prewarmPromise;
}

module.exports = {
  speak,
  speakStreaming,
  cancelSpeak,
  tryVoiceboxPlayUrl,
  probeHealth,
  prewarmVoicebox,
  getVoiceboxHqStatus,
  getCachedAudio,
  cacheAudio,
  publicAudioUrl,
  publicContinueUrl,
  mapLanguage,
  isValidAudio,
  setVoiceboxClientForTests,
  resetVoiceboxBridgeForTests,
  takePendingRest,
  getPendingRest,
  getVoiceboxStats: () => ({ ...stats }),
};

try {
  const { setBargeInListener } = require("./auraVoiceCallRuntime.cjs");
  setBargeInListener((callSid) => {
    void cancelSpeak(callSid);
  });
} catch (e) {
  console.warn("[aura/voicebox] barge-in hook skipped:", e?.message || e);
}
