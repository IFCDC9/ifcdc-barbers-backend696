# AURA × Pipecat

Pipecat is a **parallel orchestration layer** on the existing Aura / Twilio / Voicebox path. It does **not** replace Aura brain, booking, Twilio console config, or Founder-approved Sample A (Kokoro `af_heart`).

Default: **production TTS is still Polly**. `PIPECAT_ENABLED` default **0**. `VOICEBOX_PRIMARY` default **0**.

## What Pipecat is used for

Streaming / first-phrase chunking, turn detection, barge-in, cancel speech, silence, pacing, language switch, recovery.

Latency trick: long booking lines start with a complete phrase (**“Absolutely…”** / **“Claro que sí…”**) while the rest synthesizes. The Aura greeting **“Hi, this is Aura…”** is never chopped.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `PIPECAT_ENABLED` | `0` | Test-path orchestrator (chunking + continue Play). Live Twilio still Polly unless Voicebox primary is also on. |
| `VOICEBOX_PRIMARY` | `0` | Use Voicebox `<Play>` instead of Polly `<Say>`. **Leave off on Render.** |
| `PIPECAT_SIDECAR_URL` | `http://127.0.0.1:8766` | Optional Founder-Mac sidecar |

Do **not** set `VOICEBOX_PRIMARY=1` globally or on Render.

## How Tessa enables later

1. Founder Mac: Voicebox open, Kokoro loaded, Sample A profile named **AURA — FOUNDER APPROVED V1**.
2. Optional sidecar: `python3 tools/pipecat/sidecar.py` (pipecat-ai 1.6+ needs Python **3.11+**; sidecar still serves `/health` on 3.9 without the package).
3. Test path only: `PIPECAT_ENABLED=1` (streaming first phrase). Production stays Polly.
4. When ready for live Voicebox Play: `VOICEBOX_PRIMARY=1` **only** on the host that can reach `VOICEBOX_BASE_URL` (Founder Mac or a documented private tunnel). `PUBLIC_API_URL` must be HTTPS public so Twilio can `<Play>` `/api/aura/voicebox/audio/:id`.
5. Leave entitlements, booking DB, Management Team, PayPal, and the `$0.99` fee untouched.

## Language routing

| Lang | Engine | Same speaker as Sample A? |
|---|---|---|
| EN | Voicebox Kokoro `af_heart` | yes |
| ES | Voicebox Kokoro `af_heart` | closest same-person Spanish Kokoro allows |
| HE | **Polly fallback** | no — do not force slow Kokoro Hebrew into production |

## Files

- `auraPipecatFlags.cjs` — `PIPECAT_ENABLED` default 0
- `auraPipecatPipeline.cjs` — chunking, VAD/turns, barge-in, language, recovery, metrics
- `auraPipecatTwilio.cjs` — mock Twilio Media Stream + HQ Twilio/Polly status
- `tools/pipecat/sidecar.py` — optional local sidecar
- Twilio Gather continue: `POST /api/aura/voicebox/continue/:token` (Polly fallback if rest fails)

## Tests

`node --test tests/auraVoicebox.test.mjs` (1–20, hard PASS/FAIL).
