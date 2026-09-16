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

## Model chosen

**Tested locally: Kokoro 82M** (`downloaded=true`, `loaded=true`). Female preset **`af_heart`** (warm) for AURA ALLAH. Qwen3-TTS 1.7B is in the UI but was **not downloaded**, so it was not ranked as “best” — only downloaded engines are tested.

Kokoro presets cover EN and ES. Live check: ES completed in ~4.4s; HE completed in ~22s on Kokoro (too slow for a Twilio webhook, so the phone path will **fallback** until a faster multilingual model such as Qwen 1.7B is downloaded). Qwen 1.7B remains the strongest *candidate* once downloaded.

1. Qwen TTS 1.7B (multilingual EN/ES/HE)
2. Qwen CustomVoice 1.7B
3. TADA 3B multilingual
4. Qwen 0.6B variants
5. Chatterbox multilingual
6. Kokoro 82M (EN/ES presets, **no Hebrew**)

Kokoro female presets matching character: `af_heart` (warm). Qwen CustomVoice female preset closest: `Serena` (API labels it `zh`). Designed voice + `instruct` is used so the **same profile** speaks EN/ES/HE.

## Profile AURA ALLAH

- Created via `POST /profiles` if missing (`id` `808d37fe-02e0-49bd-8d1d-e54e7ff97b34` on Founder Mac)
- **Not cloned** (`voice_type`: `preset`, Kokoro `af_heart`)
- Character: female, warm, soft, confident, mature-youthful, conversational; never caricature/stereotype
- **Not locked** — samples A–E are for Founder choice
- Sample sentence (same for A–E) with five `instruct` variants in `auraVoiceboxProfile.cjs`
- Audio (outside git): `~/Documents/ifcdc-aura-voice-samples/aura-allah-sample-{A-E}.wav`

## Tests 1–17

All **PASS** (`node --test tests/auraVoicebox.test.mjs`). See `docs/AURA_VOICEBOX_TEST_RESULTS.md`. Live Voicebox health was used for tests 1 and 3. Timeout/outage/invalid-audio used a mock client (honest: not a live crash). Live EN samples A–E generated on Kokoro.

## How Tessa enables Voicebox primary

1. On the **Founder Mac** (Voicebox open, a multilingual model downloaded and loaded):
   - `VOICEBOX_PRIMARY=1`
   - `VOICEBOX_BASE_URL=http://127.0.0.1:17493` (default)
   - Restart the local API
2. Twilio `<Play>` needs a **public** `PUBLIC_API_URL` that can fetch `/api/aura/voicebox/audio/:id`. Localhost Play URLs are rejected and **fall back to Polly**.
3. **Do not** set `VOICEBOX_PRIMARY=1` on Render until there is a **documented private tunnel** from Render → Founder Mac, and `VOICEBOX_BASE_URL` is that tunnel URL. Default Render path is Polly.
4. Leave `ENTITLEMENTS_ENFORCE=0` unless Tessa separately authorizes it. This work does not touch entitlements.

## Files

- `auraVoiceboxFlags.cjs` — `VOICEBOX_PRIMARY` default 0
- `auraVoiceboxClient.cjs` — real HTTP client
- `auraVoiceboxBridge.cjs` — `speak()`, health, queue, cancel, stream, fallback
- `auraVoiceboxProfile.cjs` — engine ranking + AURA ALLAH body
- `auraVoiceboxRoutes.cjs` — audio + HQ memory
- `auraVoicePronunciation.cjs` / `auraVoiceMemory.cjs`
- `auraVoiceReply.js` / `auraVoiceCallRuntime.cjs` / `auraLocale.js` — Gather path extended
- `client/src/pages/AdminAuraVoice.jsx` — VOICEBOX STATUS panel
- `tests/auraVoicebox.test.mjs`
- `scripts/generate-aura-voice-samples.mjs`

## Remaining limits

- Gather still has no raw PCM / true AEC; barge-in is Twilio + cancel of Voicebox jobs
- Polly fallback cannot speak Hebrew (no Polly HE voice on this stack)
- Same-person multilingual quality depends on the downloaded engine (Kokoro HE is slow ~22s)
- Streaming WAV is used when `POST /generate/stream` works; Twilio Gather still needs a complete Play URL
- Render cannot reach Founder Mac Voicebox without a tunnel
- Voice memory is file-backed (`data/aura-voice-memory.json`), not production Postgres (schema freeze)
