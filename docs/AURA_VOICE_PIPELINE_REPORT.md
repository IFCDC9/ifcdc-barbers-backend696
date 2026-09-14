# AURA real-time voice pipeline — production fix report

## 1. Root cause of background-noise triggering

Primary phone path is Twilio `<Gather>` → `SpeechResult`. The server never sees raw PCM, so HVAC/TV/music become **transcripts**. Those transcripts were treated as caller turns. Rejected noise still **spoke** (“speak closer”), so the room triggered AURA. Filler `<Say>` on `/voice` (“Got it… / Checking the schedule”) was not stored for echo checks, so Polly audio looping back looked like a new caller. Empty `/process` retries were mapped to `"hello"`, which replayed the greeting.

On Media Streams, OpenAI `server_vad` plus forwarding of energetic μ-law frames could start a turn from loud TV; greeting `response.create` ran on every socket open.

## 2. Root cause of repeated responses

Several stack layers generated **more than one spoken line per caller turn**:

- `/voice` filler TTS + `/process` full reply
- Gather timeout `<Say>still here</Say>` plus a new “sorry I didn’t catch that”
- Twilio retries of `/process` after stash take fell through to `"hello"` / welcome
- Intelligence treated every `"hello"` as a fresh greeting even after `greeted=true`
- Booking mapped `"hello"` to empty input, which re-entered START or re-asked service
- Repeat guard was **exact string only**
- OpenAI voice completion was **stateless** (one user blob, no in-call ledger)
- Concurrent `/process` could run two generations

## 3. Audio / VAD settings changed

- Echo check uses the last **6** assistant lines (overlap ≥ 0.62)
- Noise / echo / barge-in fragments / multi-speaker → **`silent_listen`** (Gather + Pause, no Say)
- Realtime μ-law: listen margin 4.2, barge margin 8.5; sustain 100 ms listen / 360 ms barge-in
- Realtime VAD still higher while AURA speaks (`0.55` listen / `0.72` barge)
- Listen-path confidence default remains **0.50** so normal speech is not over-filtered
- Removed spoken waiting-ack on `/voice` (redirect only) to cut echo and latency

## 4. Deduplication / idempotency changes

New `auraVoiceCallRuntime.cjs`:

- Unique `turnId` / `eventId` per accepted caller turn
- Fingerprint of speech+digits+confidence: same event before TwiML is **same turn**; after TwiML is **replay**, not a new generation
- `runExclusiveTurn` coalesces concurrent webhook handlers (one primary generation)
- Empty `/process` replays last TwiML instead of inventing `"hello"`

## 5. In-call memory / state changes

Per-call ledger (not long-term dump): caller turns, AURA turns, completed actions, booking slots, questions answered, pending question, current intent, last confirmed.

Booking machine syncs the ledger. `generateAuraReply` injects **only this-call collected fields** into the model. `"hello"` no longer resets START. Intelligence does not re-greet on `"hello"` after the first greeting.

User/business and operational memory stay in existing Phase 1 stores; they are not dumped into every Gather turn.

## 6. Barge-in behavior changes

- Gather: barge-in candidate marks playback interrupted; short/irrelevant/low-confidence interrupts stay silent
- Interrupted playback is **not** auto-restarted
- Realtime: `response.cancel` + Twilio `clear` on speech_started while assistant speaking; 400 ms debounce; no second greeting on the same stream

## 7. Test results

- `node --test tests/auraVoiceNoiseControl.test.mjs tests/auraVoicePipeline.test.mjs` — **22/22 pass**
- `node tests/auraVoicePipelineHarness.mjs` — scenarios **1–12 all PASS (harness)**
- Transcripts/metrics: `docs/AURA_VOICE_PIPELINE_TEST_REPORT.md`
- **Not physically tested:** live TV, speakerphone echo, PSTN, Twilio internet retries, OpenAI Realtime against a room, TestFlight AEC

## 8. Remaining limitations

- Gather path cannot run true AEC/NS/AGC or speaker lock before STT
- Room noise that STT turns into a **relevant** booking sentence can still be accepted
- Ledger is process-local (lost on Render restart mid-call)
- Confirm-critical still asks to confirm mid-confidence dates/times (safety, not a miss)

## 9. Deployment commit / build

- iOS TestFlight: **not required** (no mobile voice client change; audio still streams via Twilio / optional Media Streams)
- Same repo serves `ifcdc-barbers-backend696` and `aura-backend` — one `main` commit
- Commit: `6ecb5f4a07188d8acd6dc8cebd876c77aa1884fe` (`fix(voice): stop noise/echo turns and duplicate AURA replies`)
- Build: Render `npm run build` writes `DEPLOY_COMMIT.txt` from `git rev-parse HEAD` on deploy of this SHA
