# Aura chat and phone playback reliability

Prepared against Barbers main 162f6fb24394cc6894169542b422a03f54951ac3.

## Verified source findings

The active server.js chat handler returned the generic menu for every message
of two words or fewer. Keyword matching also treated cancellation or existing
appointment questions as new bookings. It appended a repeated navigation menu
to unrelated model answers and provider failures.

Both active and compatibility handlers now preserve short answers and recent
conversation history, prioritize the explicit current message over stale
history, bound message counts/size and discard client system roles. Appointment
management and negated booking requests bypass new-booking shortcuts and reach
the conversation model. Explicit standalone help retains the instant menu.
System instructions require honest navigation guidance: text chat has no action
execution tools. The existing model/key remain unchanged; provider requests have
a 20-second timeout. Valid short replies now use the configured paid model.

## Phone mode and limits

Primary phone replies place Say/Play inside a Twilio Gather. That listens during
playback; post-transcription rejection cannot prevent the initial cutoff.
AURA_VOICE_PROTECT_PLAYBACK=1 moves the reply before Gather, including Voicebox
continuations, so callers hear the complete reply before listening starts.
This is half-duplex turn protection, not background-noise cancellation or speaker
identification. A caller must wait until the reply ends. It does not distinguish
background voices while listening and does not alter the alternate OpenAI
Realtime or native microphone paths. Default remains off for controlled rollout.

## Review and rollout

1. Apply this patch on its own Barbers branch, review, run tests, and merge.
2. Deploy the Barbers API service ifcdc-barbers-backend696, not IFCDC-HQ.
3. On that service set AURA_VOICE_PROTECT_PLAYBACK=1 for the protected phone test.
   No new key or paid integration is required. Roll back this setting to 0 to
   restore listening during playback. Revert the commit to roll back chat changes.
4. Confirm /api/aura/status and /api/health on the expected deployment; neither
   proves reply quality or voice performance by itself.
5. In the installed Barbers app, test a conversation containing a short name,
   tomorrow afternoon, a correction, a cancellation question and an existing
   appointment question. Ensure no claim of a completed action without execution.
6. Call Aura's configured phone line in quiet surroundings and with clippers,
   nearby conversation and music. Verify the full greeting, natural pauses,
   caller audibility after playback and successful booking confirmation only
   following backend success. Do not create a real paid booking unintentionally.
7. If the failure is native microphone voice rather than a phone call, reproduce
   that path separately before enabling any untested native audio changes.

## Local verification

node --test tests/auraChatConversation.test.mjs tests/auraVoicePlaybackPolicy.test.mjs tests/auraVoiceNoiseControl.test.mjs tests/auraLocaleHebrew.test.mjs tests/auraVoiceTurnTaking.test.mjs tests/auraVoicePipeline.test.mjs tests/auraVoiceBookingBridge.test.mjs tests/auraVoiceIntelligence.test.mjs

Chat tests execute the actual active handler with a mocked provider. Playback
tests inspect generated TwiML for protected and legacy modes. Existing voice
state and booking tests remain separate. These do not prove a physical noisy-room
call, live model quality, native microphone behavior or production deployment.
