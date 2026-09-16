# AURA ALLAH — FOUNDER APPROVED V1

Updated: 2026-09-16T15:09:34.573Z

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

- Name: **AURA ALLAH — FOUNDER APPROVED V1**
- Id: `b33b369d-4804-457a-a847-8dc9e4bb7d18`
- Type: preset · kokoro / af_heart
- Created this run: false · updated: false

## HQ

Path: `/admin/aura-voice`

- Founder-approved voice = A (`af_heart`)
- Active test model = Kokoro
- Production activation = OFF
- Fallback = Polly / Twilio Say

## Latency (live Voicebox, this run)

| Lang | Phrase | First-byte | Total | Bytes |
|---|---|---|---|---|
| EN | short | 2637 ms | 2638 ms | 63644 |
| EN | booking | 13529 ms | 13533 ms | 440924 |
| ES | short | 2622 ms | 2623 ms | 78044 |
| ES | booking | 13970 ms | 13973 ms | 468524 |
| HE | short (measure only) | 5626 ms | 5629 ms | 177644 |

HE policy: **polly_fallback**. Kokoro has no Hebrew speaker identity. Live Kokoro HE is too slow for a Twilio webhook, so HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna until a faster same-speaker multilingual model is Founder-approved.

## EN / ES / HE identity

- EN: same speaker (af_heart).
- ES: same Kokoro af_heart speaker — closest same-person Spanish Kokoro allows.
- HE: not the same speaker. Kokoro has no Hebrew identity; HE uses Polly fallback. Polly has no HE voice on this stack, so Hebrew callers currently hear English Polly.Joanna.

## How to enable later

1. On the Founder Mac with Voicebox open and Kokoro loaded: `VOICEBOX_PRIMARY=1`
2. `VOICEBOX_BASE_URL=http://127.0.0.1:17493`
3. Public `PUBLIC_API_URL` that Twilio can fetch (`/api/aura/voicebox/audio/:id`). Localhost Play URLs fall back to Polly.
4. Do **not** set `VOICEBOX_PRIMARY=1` on Render until a private tunnel exists.
5. Leave entitlements / booking / Management Team flags untouched.
