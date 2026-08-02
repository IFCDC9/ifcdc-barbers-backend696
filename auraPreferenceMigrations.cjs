/**
 * Phase 3B1 customer preference tables — additive, soft-delete + audit events.
 */
async function ensureAuraPreferenceTables(dbQuery) {
  if (typeof dbQuery !== "function") return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_customer_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL,
      preference_type TEXT NOT NULL,
      preference_value JSONB NOT NULL,
      consent_status TEXT NOT NULL DEFAULT 'pending',
      consent_timestamp TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'customer',
      source TEXT NOT NULL DEFAULT 'aura_chat',
      audit_metadata JSONB,
      CONSTRAINT aura_pref_type_chk CHECK (preference_type IN (
        'preferred_barber',
        'preferred_services',
        'preferred_days',
        'preferred_time_ranges',
        'preferred_language',
        'communication_preference',
        'accessibility_notes'
      )),
      CONSTRAINT aura_pref_consent_chk CHECK (consent_status IN (
        'pending', 'granted', 'declined', 'withdrawn'
      )),
      CONSTRAINT aura_pref_created_by_chk CHECK (created_by IN (
        'customer', 'aura', 'admin'
      ))
    )
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS aura_customer_preferences_active_uniq
    ON aura_customer_preferences (customer_id, preference_type)
    WHERE deleted_at IS NULL AND consent_status = 'granted'
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_customer_preferences_customer_idx
    ON aura_customer_preferences (customer_id)
    WHERE deleted_at IS NULL
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_customer_preference_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      preference_id UUID REFERENCES aura_customer_preferences(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      preference_type TEXT,
      snapshot JSONB,
      actor TEXT,
      actor_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_pref_events_customer_idx
    ON aura_customer_preference_events (customer_id, created_at DESC)
  `);
}

module.exports = { ensureAuraPreferenceTables };
