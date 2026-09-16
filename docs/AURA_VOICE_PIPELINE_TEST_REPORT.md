# AURA voice pipeline test report

Generated: 2026-09-14T01:25:34.880Z

This harness **injects transcripts, confidence scores, and synthetic μ-law frames**.
It does **not** claim live microphone, television, or PSTN results.

## Scenarios 1–12

### 1. TV dialogue in room — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"transcript","text":"Coming up next after the commercial break","confidence":0.91}`
- Result: `{"gate":"silent_listen","reason":"background_media","auraSpoke":false}`
- Notes: Injected STT only. Could NOT play a physical TV next to a phone.

### 2. Music / radio bed — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"transcript","text":"You're listening to the now playing radio station mix","confidence":0.86}`
- Result: `{"gate":"silent_listen","reason":"background_media","auraSpoke":false}`
- Notes: Injected STT. No live speaker/music test.

### 3. Other people talking — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"transcript","text":"He said \"grab the clippers\" and she said \"not now\"","confidence":0.8}`
- Result: `{"gate":"silent_listen","reason":"multi_speaker","auraSpoke":false}`
- Notes: Keyword multi-speaker heuristic on transcript. No diarization / live room.

### 4. Own TTS / echo — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"assistant_tts","text":"Hi, this is Aura. Thank you for calling the IFCDC Barbers App."}`
  - `{"kind":"transcript_echo","text":"Hi, this is Aura. Thank you for calling the IFCDC Barbers App.","confidence":0.94}`
- Result: `{"gate":"silent_listen","reason":"echo_overlap","auraSpoke":false}`
- Notes: Simulated loopback of last assistant line. No analog handset echo.

### 5. Duplicate transcript / webhook retry — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"transcript","text":"Friday afternoon fade"}`
  - `{"kind":"retry_same_transcript","text":"Friday afternoon fade"}`
- Result: `{"firstTurnId":"H5:t1:mu0k9wrg","secondDuplicate":true,"sameId":true}`
- Notes: In-process fingerprint window. No Twilio retry from the carrier.

### 6. Multiple generations per turn — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"parallel_process_webhooks","count":2}`
- Result: `{"generations":1,"sameReply":true}`
- Notes: Coalesced in-process locks. No live double HTTP from Twilio.

### 7. Barge-in mid-sentence — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"assistant_playing","text":"long service list"}`
  - `{"kind":"bargein_fragment","text":"um","confidence":0.7}`
- Result: `{"resumeOld":false,"interrupted":true,"fragment":"silent_listen"}`
- Notes: State machine only. Twilio <Gather bargeIn> not exercised on a live call.

### 8. Remembers current-call booking slots — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"caller","text":"fade"}`
  - `{"kind":"caller","text":"tomorrow"}`
- Result: `{"service":"fade","day":"2026-09-14","pending":["What time would you like?"]}`
- Notes: In-memory ledger + booking machine. No PSTN call.

### 9. No re-ask of established service on silence — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"caller","text":"haircut"}`
  - `{"kind":"no_speech"}`
- Result: `{"stage":"day","stillHasService":true,"replyAsksServiceAgain":false}`
- Notes: Silence stays on DAY. Greeting is not replayed.

### 10. Normal near-field speech accepted — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"transcript","text":"I need a fade tomorrow afternoon","confidence":0.72}`
- Result: `{"gate":"confirm_critical","reason":"confirm_critical"}`
- Notes: Confidence 0.72 listen-path. No live quiet talker.

### 11. Short barge-in fragment ignored — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"bargein","text":"hey","confidence":0.95}`
- Result: `{"gate":"silent_listen","reason":"bargein_too_short"}`
- Notes: Post-STT length gate. No live interrupt.

### 12. Realtime μ-law energy vs idle / barge-in — PASS (harness)

- Physically tested: **no**
- Injected events:
  - `{"kind":"mulaw_idle_frames","count":8}`
  - `{"kind":"mulaw_loud_frames_while_assistant","count":8}`
- Result: `{"quietForwarded":0,"loudForwardedAfterSustain":0}`
- Notes: Synthetic μ-law bytes. Could NOT run Media Streams against a TV.

## What could NOT be physically tested

- Live handset / app mic with a TV or music playing in the room
- Carrier AEC / Twilio enhanced STT on a real PSTN call
- Analog echo from a speakerphone playing Polly TTS
- Twilio webhook retries from the public internet
- OpenAI Realtime Media Streams against live audio
- iOS TestFlight AEC (no mobile client change in this pass)

## Metrics (this harness run)

- Scenarios: 12
- Harness passes: 12
- Harness fails: 0
