/**
 * Additive schema for AURA Voice Intelligence Phase 1.
 * Safe when flag is off — only created when boot enables Phase 1.
 */
async function ensureAuraVoiceIntelligenceSchema(dbQuery) {
  if (typeof dbQuery !== "function") return { ok: false, reason: "no_db" };

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_voice_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      call_sid TEXT,
      from_e164 TEXT,
      to_e164 TEXT,
      verified_status TEXT NOT NULL DEFAULT 'unverified',
      is_owner BOOLEAN NOT NULL DEFAULT FALSE,
      primary_intent TEXT,
      intents JSONB,
      actions_requested JSONB,
      actions_completed JSONB,
      actions_failed JSONB,
      confirmation_numbers JSONB,
      escalation_status TEXT NOT NULL DEFAULT 'none',
      escalation_summary TEXT,
      outcome TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_sec INT,
      conversation_summary TEXT,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_voice_calls_started_idx ON aura_voice_calls (started_at DESC)`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS aura_voice_calls_call_sid_uidx
     ON aura_voice_calls (call_sid) WHERE call_sid IS NOT NULL`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_voice_calls_from_idx ON aura_voice_calls (from_e164)
     WHERE from_e164 IS NOT NULL`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_voice_call_turns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      call_id UUID REFERENCES aura_voice_calls(id) ON DELETE CASCADE,
      call_sid TEXT,
      turn_index INT NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      intent TEXT,
      user_text TEXT,
      assistant_text TEXT,
      action TEXT,
      action_ok BOOLEAN,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_voice_call_turns_call_idx
     ON aura_voice_call_turns (call_id, turn_index)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_voice_caller_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      phone_e164 TEXT NOT NULL,
      display_name TEXT,
      preferred_barber TEXT,
      preferred_services JSONB,
      language_pref TEXT,
      last_booking_id UUID,
      unfinished_session JSONB,
      call_count INT NOT NULL DEFAULT 0,
      verified_at TIMESTAMPTZ,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS aura_voice_caller_profiles_phone_uidx
     ON aura_voice_caller_profiles (phone_e164)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_voice_escalations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      call_id UUID REFERENCES aura_voice_calls(id) ON DELETE SET NULL,
      call_sid TEXT,
      from_e164 TEXT,
      caller_name TEXT,
      reason TEXT NOT NULL,
      appointment_ref TEXT,
      actions_attempted JSONB,
      recommended_next TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_voice_escalations_created_idx
     ON aura_voice_escalations (created_at DESC)`,
  );

  return { ok: true };
}

module.exports = {
  ensureAuraVoiceIntelligenceSchema,
};
