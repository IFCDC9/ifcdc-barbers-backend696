# AURA — FOUNDER APPROVED V1

Updated: 2026-09-16T15:23:34.462Z

Founder approved Sample A as AURA voice direction. Production live calls stay Polly. `VOICEBOX_PRIMARY` remains **0 / OFF**.

## Saved settings

- Sample: **A** (round2)
- Engine / model: **kokoro / kokoro**
- Voice ID: **af_heart**
- Language: **en** (identity language)
- Speed: **1.0** (Voicebox has no speed field; 1.0 means no pace override)
- Instruct: `Warm, soft, confident, conversational. Mature-youthful. Never cartoonish or caricature.`
- Source wav (not in git): `~/Documents/ifcdc-aura-voice-samples/round2/aura-allah-A.wav`

## Voicebox profile

- Name: **AURA — FOUNDER APPROVED V1**
- Customer-facing: **Aura**
- Greeting: **Hi, this is Aura…** (never “Aura Allah”)
- Id: `b33b369d-4804-457a-a847-8dc9e4bb7d18`
- Type: preset · kokoro / af_heart
- Created this run: false · updated: true (display rename in place; voice ID unchanged)

## HQ

Path: `/admin/aura-voice`

- Founder-approved voice = A (`af_heart`)
- Active test model = Kokoro
- Production activation = OFF
- Fallback = Polly / Twilio Say
- Pipecat = test path (`PIPECAT_ENABLED` default 0)
- PRODUCTION PRIMARY = **OFF**

## Latency (this run)

Prior Voicebox `/generate/stream` (complete WAV, no ack-prefix):

| Lang | Phrase | First-byte | Total | Bytes |
|---|---|---|---|---|
| EN | short | 2637 ms | 2638 ms | 63644 |
| EN | booking | 13529 ms | 13533 ms | 440924 |
| ES | short | 2622 ms | 2623 ms | 78044 |
| ES | booking | 13970 ms | 13973 ms | 468524 |
| HE | short (measure only) | 5626 ms | 5629 ms | 177644 |

Pipecat streaming (tests 1–20, live Voicebox ack):

| Metric | Mock | Live Voicebox |
|---|---|---|
| First complete phrase (“Absolutely…”) | 42 ms | **5119 ms TTFB / 5168 ms total** |
| Rest of long booking line | 281 ms (mock) | still ~13s if synthesized as one WAV |
| Interrupt / recovery | < 5 ms (in-process) | n/a |

13s booking lines are not returned as a single webhook Play. The caller can hear **Absolutely…** first; rest continues in the background (`/api/aura/voicebox/continue/:token`) when `PIPECAT_ENABLED=1` and `VOICEBOX_PRIMARY=1`.

HE policy: **polly_fallback**. Kokoro has no Hebrew speaker identity. Live Kokoro HE is too slow for a Twilio webhook, so HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna until a faster same-speaker multilingual model is Founder-approved.

## EN / ES / HE identity

- EN: same speaker (af_heart).
- ES: same Kokoro af_heart speaker — closest same-person Spanish Kokoro allows.
- HE: not the same speaker. Kokoro has no Hebrew identity; HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna.

## How to enable later

1. On the Founder Mac with Voicebox open and Kokoro loaded:
   - Optional: `PIPECAT_ENABLED=1` and `python3 tools/pipecat/sidecar.py`
   - `VOICEBOX_PRIMARY=1` only when Twilio should Play Sample A
2. `VOICEBOX_BASE_URL=http://127.0.0.1:17493`
3. Public `PUBLIC_API_URL` that Twilio can fetch (`/api/aura/voicebox/audio/:id`). Localhost Play URLs fall back to Polly.
4. Do **not** set `VOICEBOX_PRIMARY=1` on Render until a private tunnel exists. Do **not** set it globally.
5. Leave entitlements / booking / Management Team flags untouched.

See `docs/AURA_PIPECAT.md`.
