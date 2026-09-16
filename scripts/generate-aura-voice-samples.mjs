/**
 * Generate AURA founder-approved samples A–E (same sentence, five instructs).
 * Writes audio outside git: ~/Documents/ifcdc-aura-voice-samples/
 * Does not clone. Does not enable VOICEBOX_PRIMARY.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVoiceboxClient } = require("../auraVoiceboxClient.cjs");
const {
  AURA_ALLAH_NAME,
  SAMPLE_INSTRUCTS,
  SAMPLE_SENTENCE,
  selectBestLocalEngine,
  ensureAuraAllahProfile,
} = require("../auraVoiceboxProfile.cjs");
const { isValidAudio } = require("../auraVoiceboxBridge.cjs");

const OUT_DIR = join(homedir(), "Documents", "ifcdc-aura-voice-samples");

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = createVoiceboxClient();
  const health = await client.health(3000);
  const models = await client.modelsStatus();
  const engine = selectBestLocalEngine(models);
  const { profile, created } = await ensureAuraAllahProfile(client, engine);
  const report = {
    at: new Date().toISOString(),
    health,
    engine,
    profile: { id: profile.id, name: profile.name, voice_type: profile.voice_type, created },
    samples: {},
  };

  if (!engine.downloaded) {
    report.error =
      "No Voicebox TTS model is downloaded. Samples A–E were not generated. Open Voicebox, download a multilingual engine, re-run this script.";
    writeFileSync(join(OUT_DIR, "README.json"), JSON.stringify(report, null, 2));
    console.error(report.error);
    process.exitCode = 2;
    return;
  }

  for (const letter of Object.keys(SAMPLE_INSTRUCTS)) {
    const body = {
      profile_id: profile.id,
      text: SAMPLE_SENTENCE,
      language: "en",
      engine: engine.engine,
      model_size: engine.modelSize || "1.7B",
      instruct: SAMPLE_INSTRUCTS[letter],
      personality: false,
      normalize: true,
    };
    try {
      const streamed = await client.generateStream(body, 120000);
      if (!isValidAudio(streamed.buffer)) throw new Error("invalid_audio");
      const file = join(OUT_DIR, `aura-allah-sample-${letter}.wav`);
      writeFileSync(file, streamed.buffer);
      report.samples[letter] = { ok: true, file, bytes: streamed.buffer.length };
      console.log("wrote", file);
    } catch (e) {
      report.samples[letter] = { ok: false, error: String(e?.message || e) };
      console.error("sample", letter, e?.message || e);
    }
  }
  writeFileSync(join(OUT_DIR, "README.json"), JSON.stringify(report, null, 2));
  const failed = Object.values(report.samples).filter((s) => !s.ok).length;
  process.exitCode = failed ? 2 : 0;
  console.log(`AURA founder-approved samples for ${AURA_ALLAH_NAME} → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
