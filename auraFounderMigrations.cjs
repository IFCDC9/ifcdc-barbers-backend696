/**
 * Additive schema for AURA Founder Command Mode.
 * Safe / idempotent; never stores founder PIN values.
 */
async function ensureAuraFounderSchema(dbQuery) {
  if (typeof dbQuery !== "function") return { ok: false, reason: "no_db" };

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_founder_state (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_briefing_at TIMESTAMPTZ,
      last_call_sid TEXT,
      last_founder_from_e164 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB
    )
  `);
  await dbQuery(
    `INSERT INTO aura_founder_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_founder_activity (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      call_sid TEXT,
      from_e164 TEXT,
      event_kind TEXT NOT NULL,
      ok BOOLEAN,
      detail JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_founder_activity_created_idx
     ON aura_founder_activity (created_at DESC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_founder_activity_kind_idx
     ON aura_founder_activity (event_kind, created_at DESC)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_founder_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_type TEXT NOT NULL,
      booking_id UUID,
      customer_name TEXT,
      customer_phone_masked TEXT,
      barber_name TEXT,
      service_name TEXT,
      original_date DATE,
      original_time TEXT,
      new_date DATE,
      new_time TEXT,
      cancellation_reason TEXT,
      payment_status TEXT,
      booking_status TEXT,
      action_required BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT,
      payload JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_founder_events_created_idx
     ON aura_founder_events (created_at DESC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_founder_events_type_idx
     ON aura_founder_events (event_type, created_at DESC)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_founder_notification_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_id UUID REFERENCES aura_founder_events(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      target TEXT,
      ok BOOLEAN,
      skipped BOOLEAN NOT NULL DEFAULT FALSE,
      reason TEXT,
      detail JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_founder_notification_log_created_idx
     ON aura_founder_notification_log (created_at DESC)`,
  );

  return { ok: true };
}

module.exports = {
  ensureAuraFounderSchema,
};
