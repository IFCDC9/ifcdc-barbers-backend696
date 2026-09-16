/**
 * Founder-approved Sample A latency + identity harness.
 * Live Voicebox generate when 127.0.0.1:17493 is up. Does not enable
 * VOICEBOX_PRIMARY. Does not write wavs into the git repo.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const {
  AURA_ALLAH_NAME,
  FOUNDER_APPROVED_VOICE,
  SAMPLE_A_INSTRUCT,
  SAMPLE_SENTENCE,
  LANGUAGE_STATUS,
  ensureAuraAllahProfile,
  selectCanonicalEngine,
  heUsesPollyFallback,
} = require("../auraVoiceboxProfile.cjs");
const { persistFounderApprovedVoice } = require("../auraVoiceMemory.cjs");
const { isVoiceboxPrimary } = require("../auraVoiceboxFlags.cjs");
const { isValidAudio } = require("../auraVoiceboxBridge.cjs");

const OUT_DIR = join(homedir(), "Documents", "ifcdc-aura-voice-samples", "founder-approved-v1");
const TIMEOUT_MS = 30000;

const PHRASES = {
  en: {
    short: "Got it.",
    booking: SAMPLE_SENTENCE,
  },
  es: {
    short: "De acuerdo.",
    booking:
      "Hola, soy Aura Allah en Imperial Foundation C D C Barbers. Puedo ayudarte a reservar un corte — dime el día y la hora que te sirve.",
  },
  he: {
    short: "הבנתי.",
    booking: "שלום, כאן Aura Allah. אני יכולה לעזור לך לקבוע תור.",
  },
};

async function timeGenerate(client, body) {
  const started = Date.now();
  try {
    const streamed = await client.generateStreamMeta(body, TIMEOUT_MS);
    const totalMs = Date.now() - started;
    const ok = isValidAudio(streamed.buffer);
    return {
      ok,
      firstByteMs: streamed.firstByteMs ?? totalMs,
      totalMs,
      bytes: streamed.buffer?.length || 0,
      contentType: streamed.contentType || null,
      buffer: ok ? streamed.buffer : null,
      error: ok ? null : "invalid_audio",
    };
  } catch (e) {
    return {
      ok: false,
      firstByteMs: null,
      totalMs: Date.now() - started,
      bytes: 0,
      error: String(e?.message || e).slice(0, 220),
    };
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = createVoiceboxClient({ flags: { timeoutMs: TIMEOUT_MS } });
  const health = await client.health(3000);
  const models = await client.modelsStatus();
  const engine = selectCanonicalEngine(models);
  const { profile, created, updated } = await ensureAuraAllahProfile(client, engine);
  persistFounderApprovedVoice({
    profileId: profile.id,
    profileName: profile.name,
    voiceId: profile.preset_voice_id || FOUNDER_APPROVED_VOICE.voiceId,
  });

  // Prewarm Kokoro so timed runs are not the cold load.
  await timeGenerate(client, {
    profile_id: profile.id,
    text: "Hi.",
    language: "en",
    engine: "kokoro",
    instruct: SAMPLE_A_INSTRUCT,
    personality: false,
    max_chunk_chars: 120,
    crossfade_ms: 40,
    normalize: true,
  });

  const report = {
    at: new Date().toISOString(),
    voiceboxPrimary: isVoiceboxPrimary(),
    productionActivation: "OFF",
    founderApproved: FOUNDER_APPROVED_VOICE,
    profile: {
      id: profile.id,
      name: profile.name,
      voice_type: profile.voice_type,
      preset_engine: profile.preset_engine,
      preset_voice_id: profile.preset_voice_id,
      created,
      updated,
    },
    engine,
    health,
    languages: LANGUAGE_STATUS,
    hePollyFallback: heUsesPollyFallback(),
    runs: {},
    notes: [
      "VOICEBOX_PRIMARY remains 0. This harness only measures the test Voicebox path.",
      "Audio files (if written) stay under ~/Documents and are not committed.",
      "Kokoro /generate/stream typically delivers a complete WAV, so first-byte can be close to total.",
    ],
  };

  for (const lang of ["en", "es"]) {
    report.runs[lang] = {};
    for (const kind of ["short", "booking"]) {
      const body = {
        profile_id: profile.id,
        text: PHRASES[lang][kind],
        language: lang,
        engine: "kokoro",
        instruct: `${SAMPLE_A_INSTRUCT} Phone-call clarity. Natural pauses. Same woman; never cartoonish.`,
        personality: false,
        max_chunk_chars: 120,
        crossfade_ms: 40,
        normalize: true,
      };
      const result = await timeGenerate(client, body);
      const { buffer, ...row } = result;
      report.runs[lang][kind] = row;
      if (result.ok && buffer && kind === "booking") {
        writeFileSync(join(OUT_DIR, `aura-allah-founder-v1-${lang}-${kind}.wav`), buffer);
      }
      console.log(lang, kind, result.ok ? `${result.firstByteMs} / ${result.totalMs} ms` : result.error);
    }
  }

  const heBody = {
    profile_id: profile.id,
    text: PHRASES.he.short,
    language: "he",
    engine: "kokoro",
    instruct: SAMPLE_A_INSTRUCT,
    personality: false,
    max_chunk_chars: 120,
    crossfade_ms: 40,
    normalize: true,
  };
  const he = await timeGenerate(client, heBody);
  const { buffer: heBuf, ...heRow } = he;
  void heBuf;
  report.runs.he = {
    short: heRow,
    policy: he.ok && he.totalMs < 4000 ? "voicebox_ok_but_identity_unverified" : "polly_fallback",
    note: LANGUAGE_STATUS.he.note,
  };
  console.log("he short", he.ok ? `${he.firstByteMs} / ${he.totalMs} ms` : he.error);

  writeFileSync(join(OUT_DIR, "latency-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    new URL("../docs/AURA_FOUNDER_APPROVED_VOICE.md", import.meta.url),
    [
      "# AURA ALLAH — FOUNDER APPROVED V1",
      "",
      `Updated: ${report.at}`,
      "",
      "Founder approved Sample A as AURA voice direction. Production live calls stay Polly. `VOICEBOX_PRIMARY` remains **0 / OFF**.",
      "",
      "## Saved settings",
      "",
      `- Sample: **A** (round2)`,
      `- Engine / model: **kokoro / kokoro**`,
      `- Voice ID: **af_heart**`,
      `- Language: **en** (identity language)`,
      `- Speed: **1.0** (Voicebox has no speed field; 1.0 means no pace override)`,
      `- Instruct: \`${SAMPLE_A_INSTRUCT}\``,
      `- Source wav (not in git): \`${FOUNDER_APPROVED_VOICE.sourceFile}\``,
      "",
      "## Voicebox profile",
      "",
      `- Name: **${AURA_ALLAH_NAME}**`,
      `- Id: \`${profile.id}\``,
      `- Type: ${profile.voice_type} · ${profile.preset_engine} / ${profile.preset_voice_id}`,
      `- Created this run: ${created} · updated: ${updated}`,
      "",
      "## HQ",
      "",
      "Path: `/admin/aura-voice`",
      "",
      "- Founder-approved voice = A (`af_heart`)",
      "- Active test model = Kokoro",
      "- Production activation = OFF",
      "- Fallback = Polly / Twilio Say",
      "",
      "## Latency (live Voicebox, this run)",
      "",
      `| Lang | Phrase | First-byte | Total | Bytes |`,
      `|---|---|---|---|---|`,
      `| EN | short | ${report.runs.en.short.firstByteMs ?? "—"} ms | ${report.runs.en.short.totalMs} ms | ${report.runs.en.short.bytes} |`,
      `| EN | booking | ${report.runs.en.booking.firstByteMs ?? "—"} ms | ${report.runs.en.booking.totalMs} ms | ${report.runs.en.booking.bytes} |`,
      `| ES | short | ${report.runs.es.short.firstByteMs ?? "—"} ms | ${report.runs.es.short.totalMs} ms | ${report.runs.es.short.bytes} |`,
      `| ES | booking | ${report.runs.es.booking.firstByteMs ?? "—"} ms | ${report.runs.es.booking.totalMs} ms | ${report.runs.es.booking.bytes} |`,
      `| HE | short (measure only) | ${report.runs.he.short.firstByteMs ?? "—"} ms | ${report.runs.he.short.totalMs} ms | ${report.runs.he.short.bytes} |`,
      "",
      `HE policy: **${report.runs.he.policy}**. ${LANGUAGE_STATUS.he.note}`,
      "",
      "## EN / ES / HE identity",
      "",
      `- EN: same speaker (${FOUNDER_APPROVED_VOICE.voiceId}).`,
      `- ES: same Kokoro ${FOUNDER_APPROVED_VOICE.voiceId} speaker — closest same-person Spanish Kokoro allows.`,
      `- HE: not the same speaker. Kokoro has no Hebrew identity; HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna.`,
      "",
      "## How to enable later",
      "",
      "1. On the Founder Mac with Voicebox open and Kokoro loaded: `VOICEBOX_PRIMARY=1`",
      "2. `VOICEBOX_BASE_URL=http://127.0.0.1:17493`",
      "3. Public `PUBLIC_API_URL` that Twilio can fetch (`/api/aura/voicebox/audio/:id`). Localhost Play URLs fall back to Polly.",
      "4. Do **not** set `VOICEBOX_PRIMARY=1` on Render until a private tunnel exists.",
      "5. Leave entitlements / booking / Management Team flags untouched.",
      "",
    ].join("\n"),
  );

  if (!report.voiceboxPrimary) {
    console.log("VOICEBOX_PRIMARY still off (expected).");
  }
  console.log("profile", profile.id, profile.name);
  console.log("report", join(OUT_DIR, "latency-report.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
