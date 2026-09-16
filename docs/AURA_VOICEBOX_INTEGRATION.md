# AURA × Voicebox integration

Voicebox is a **parallel TTS provider**. AURA brain, booking, Twilio Gather, HQ memory, PayPal, `$0.99` booking fee, `ENTITLEMENTS_ENFORCE`, and Management Team are unchanged.

**Path:** CALL → AURA intelligence → existing booking logic → language decision → Voicebox (if `VOICEBOX_PRIMARY=1`) → speech. On crash, timeout, or invalid audio → **Polly / Twilio `<Say>`**. No dropped calls.

## Voicebox API found (local inspect)

| Item | Value |
|---|---|
| App | `/Applications/Voicebox.app` v0.5.0 (`sh.voicebox.app`) |
| Process | `voicebox-server` listening **`127.0.0.1:17493`** |
| API | FastAPI, `GET /` → `{"message":"voicebox API","version":"0.5.0"}` |
| Docs | `http://127.0.0.1:17493/docs` · OpenAPI `/openapi.json` |
| Support | `~/Library/Application Support/sh.voicebox.app/voicebox.db` |
| Binary | `Contents/MacOS/voicebox-server` |

**Real endpoints used (not invented):** `GET /health`, `GET /models/status`, `GET/POST /profiles`, `GET /profiles/presets/{engine}`, `POST /generate`, `POST /generate/stream`, `GET /generate/{id}/status`, `POST /generate/{id}/cancel`, `GET /audio/{id}`, `GET /history/{id}`, `POST /speak`.

**Engines in OpenAPI:** `qwen`, `qwen_custom_voice`, `luxtts`, `chatterbox`, `chatterbox_turbo`, `tada`, `kokoro`.

**Languages in OpenAPI (includes HE):** `zh en ja ko de fr ru pt es it he ar da el fi hi ms nl no pl sv sw tr`.

**Profile format:** `{ name, description, language, voice_type: cloned|preset|designed, preset_engine, preset_voice_id, design_prompt, default_engine, personality }`. Samples are clone audio — **not used** (no Founder-approved clone files found under Documents).

**Generation request:** `{ profile_id, text, language, seed, model_size (1.7B\|0.6B\|1B\|3B), instruct, engine, personality, max_chunk_chars, crossfade_ms, normalize }`. There is **no `speed` field**; pace is mapped into `instruct`.

## Model chosen (Founder-approved)

**Canonical identity: Sample A (round2) — Kokoro 82M preset `af_heart`.** Qwen 1.7B may be downloaded on the Founder Mac; it is **not** the approved speaker and is not used for AURA speech.

- Engine / model: `kokoro` / `kokoro`
- Voice ID: `af_heart`
- Speed: `1.0` (Voicebox has no speed field; 1.0 means no pace override)
- Instruct: `Warm, soft, confident, conversational. Mature-youthful. Never cartoonish or caricature.`
- Production activation: **OFF**. `VOICEBOX_PRIMARY` default **0**. Polly remains the live-call path.

Kokoro presets cover EN and ES with the **same speaker** (`af_heart`) as closely as Kokoro allows. Hebrew is **not** the same speaker: Kokoro has no HE identity, live Kokoro HE is too slow for a Twilio webhook, and Polly has no HE voice on this stack — HE callers currently hear English Polly.Joanna.

## Profile AURA — FOUNDER APPROVED V1

- Named Voicebox profile created via `POST /profiles` if missing; renamed in place via `PUT /profiles/{id}` when the display name changes (voice ID stays `af_heart`)
- Public display name: **AURA — FOUNDER APPROVED V1**. Customer-facing spoken name: **Aura**. Greeting: **Hi, this is Aura…** (never “Aura Allah”)
- Internal symbols such as `AURA_ALLAH_NAME` may remain for stable refs
- **Not cloned** (`voice_type`: `preset`, Kokoro `af_heart`)
- Canonical in repo: `auraVoiceboxProfile.cjs` → `FOUNDER_APPROVED_VOICE`
- Persisted in voice memory: `data/aura-voice-memory.json` (`founderApprovedVoice`; gitignored runtime copy)
- HQ: `/admin/aura-voice` (Founder-approved voice = A / `af_heart`, production activation OFF)
- Source wav (not in git): `~/Documents/ifcdc-aura-voice-samples/round2/aura-allah-A.wav`

## Tests 1–20

Run `node --test tests/auraVoicebox.test.mjs`. Live Voicebox health is used for tests 1, 3, and 18 (first-phrase ack). Timeout/outage/invalid-audio use a mock client. Latency harness: `node scripts/measure-aura-founder-voice.mjs` (writes wavs under `~/Documents`, not git).

18. Streaming starts **“Absolutely…”** while the rest of a long booking line synthesizes (greeting is not chopped).
19. Pipecat turn detection, barge-in, silence, language switch (ledger kept), recovery/fallback.
20. `PIPECAT_ENABLED` default 0; HQ shows Pipecat/Twilio/Polly/pipeline/last test; PRODUCTION PRIMARY OFF.

## How Tessa enables Voicebox primary

1. On the **Founder Mac** (Voicebox open, Kokoro loaded):
   - Optional test path: `PIPECAT_ENABLED=1` and `python3 tools/pipecat/sidecar.py`
   - `VOICEBOX_PRIMARY=1` only when Twilio should `<Play>` Sample A
   - `VOICEBOX_BASE_URL=http://127.0.0.1:17493` (default)
   - Restart the local API
2. Twilio `<Play>` needs a **public** `PUBLIC_API_URL` that can fetch `/api/aura/voicebox/audio/:id`. Localhost Play URLs are rejected and **fall back to Polly**.
3. **Do not** set `VOICEBOX_PRIMARY=1` on Render. Named Cloudflare Tunnel + HMAC (`VOICEBOX_TUNNEL_SECRET`) is required first (`docs/AURA_VOICEBOX_TUNNEL.md`). Default Render path is Polly. `VOICEBOX_BASE_URL` on Render is `https://aura-voice.ifcdcbarbersapp.com`, never `127.0.0.1`.
4. Leave `ENTITLEMENTS_ENFORCE=0` unless Tessa separately authorizes it. This work does not touch entitlements.

See `docs/AURA_PIPECAT.md`.

## Files

- `auraVoiceboxFlags.cjs` — `VOICEBOX_PRIMARY` default 0
- `auraPipecatFlags.cjs` — `PIPECAT_ENABLED` default 0
- `auraPipecatPipeline.cjs` / `auraPipecatTwilio.cjs` / `tools/pipecat/sidecar.py`
- `auraVoiceboxClient.cjs` — real HTTP client
- `auraVoiceboxBridge.cjs` — `speak()`, `speakStreaming()`, health, queue, cancel, stream, fallback
- `auraVoiceboxProfile.cjs` — engine ranking + AURA founder-approved body
- `auraVoiceboxRoutes.cjs` — audio + continue + HQ memory
- `auraVoicePronunciation.cjs` / `auraVoiceMemory.cjs`
- `auraVoiceReply.js` / `auraVoiceCallRuntime.cjs` / `auraLocale.js` — Gather path extended
- `client/src/pages/AdminAuraVoice.jsx` / `frontend/src/pages/AdminAuraVoice.jsx` — Founder-approved + Voicebox/Pipecat/Twilio/Polly + PRODUCTION PRIMARY OFF
- `tests/auraVoicebox.test.mjs`
- `scripts/measure-aura-founder-voice.mjs`
- `auraVoiceboxTunnelAuth.cjs` / `auraVoiceboxTunnelProxy.cjs` — HMAC allowlisted edge
- `scripts/install-aura-voice-mac.sh` — launchd + named cloudflared (not trycloudflare)
- `docs/AURA_VOICEBOX_TUNNEL.md`

## Remaining limits

- Gather still has no raw PCM / true AEC; barge-in is Twilio + cancel of Voicebox stream/jobs
- Polly fallback cannot speak Hebrew (no Polly HE voice on this stack)
- Kokoro HE is too slow / not the same speaker → HE uses Polly fallback (English Joanna)
- `/generate/stream` typically delivers a complete WAV, so first-byte can be close to total; Pipecat ack-prefix is what makes the first *phrase* fast
- Render cannot reach Founder Mac Voicebox without a **named Cloudflare Tunnel** to the allowlisted proxy (`docs/AURA_VOICEBOX_TUNNEL.md`). `VOICEBOX_PRIMARY` stays **0**. Founder `cloudflared tunnel login` is the remaining stop for a persistent hostname.
- Voice memory is file-backed (`data/aura-voice-memory.json`), not production Postgres (schema freeze)
- Full `pipecat-ai` 1.6+ needs Python 3.11+; this Mac has 3.9 so the sidecar runs stdlib VAD unless 3.11 is installed
