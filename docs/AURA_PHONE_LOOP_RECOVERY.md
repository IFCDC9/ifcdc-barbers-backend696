# Phone conversation and booking loop recovery

The Barbers phone route is separate from HQ. HQ uses conversation/session context
and evidence-based replies; the default Barbers phone route normally consumes all
utterances through a booking state machine. This change adopts contextual reply
handling for public phone questions without connecting public callers to private
HQ sessions, memory, or executive tools. It is not a wholesale HQ engine migration.

## Causes addressed

- The semantic repetition guard emitted the exact phrase "I already have that."
  It could overwrite a legitimate tool follow-up or corrected confirmation.
- Transcript deduplication could replay an older answer after intervening turns.
  Identical words are now coalesced only with the current turn. Stable webhook
  event IDs still replay the original result to avoid executing actions again.
- Saying no at confirmation discarded the entire draft. A recognized service,
  date, or time correction now preserves other details and requires another
  confirmation. A qualified yes does not submit an unrecognized correction.
- Public side questions could become a service or name. The default phone path
  now answers these with bounded recent history and the in-call ledger while
  preserving the draft. The reply step has no execution tools, cannot verify
  shop facts, and is instructed to say when facts need checking.

## Validation and rollout

Regression tests exercise the actual process handler with mocked model responses,
question context, correction through a single mocked booking insert, repeated
answers, retry replay, and the exact reported anti-repeat phrase. No live model,
call, payment, email, or booking is needed for these tests.

Merge after Founder review, deploy the Barbers backend, then place a real test
call. Request a haircut, supply a day/time, ask a side question, supply a name,
then correct the time at confirmation. Verify retained details and finish only
with an intentional test booking or hang up before the final yes.

Conversational side questions use the existing OPENAI_API_KEY/OPENAI_MODEL and may
incur configured API usage. No new provider is connected. Model requests abort
after four seconds; missing configuration/errors use a conservative fallback.

For playback interruption, separately enable AURA_VOICE_PROTECT_PLAYBACK=1 on the
Barbers service. This finishes Aura's reply before listening; it prevents caller
barge-in as well as noise interruption during playback. It is not acoustic noise
cancellation and does not reject all background speech during listening.

Phase 1 intelligence still runs first when enabled; its replies no longer get
overwritten by the semantic guard, but its separate booking state machine is not
replaced here. Wizard, native microphone, and alternate realtime paths are not
changed. In-call state remains process-local and can be lost on restarts or
multi-instance routing. Live phone behavior and deployed flags require verification.

Rollback: revert this change for conversation behavior; disable the playback
environment flag independently to restore phone barge-in.
