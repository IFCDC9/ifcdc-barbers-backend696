/**
 * Phase 3B2 waitlist + slot-offer tables — additive, soft-delete + audit events.
 */
async function ensureAuraWaitlistTables(dbQuery) {
  if (typeof dbQuery !== "function") return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_waitlist_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL,
      barber_id UUID,
      barber_name TEXT,
      any_qualified_barber BOOLEAN NOT NULL DEFAULT FALSE,
      service_id TEXT,
      service_name TEXT,
      preferred_date DATE,
      date_from DATE,
      date_to DATE,
      earliest_acceptable_date DATE,
      time_range_start TEXT,
      time_range_end TEXT,
      earliest_available BOOLEAN NOT NULL DEFAULT FALSE,
      match_flexibility JSONB,
      status TEXT NOT NULL DEFAULT 'pending_consent',
      priority_basis TEXT NOT NULL DEFAULT 'created_at_fifo',
      consent_status TEXT NOT NULL DEFAULT 'pending',
      consent_timestamp TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      criteria_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'customer',
      source TEXT NOT NULL DEFAULT 'aura_chat',
      audit_metadata JSONB,
      CONSTRAINT aura_waitlist_status_chk CHECK (status IN (
        'pending_consent', 'active', 'paused', 'expired', 'fulfilled', 'cancelled', 'declined_consent'
      )),
      CONSTRAINT aura_waitlist_consent_chk CHECK (consent_status IN (
        'pending', 'granted', 'declined', 'withdrawn'
      ))
    )
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_waitlist_requests_customer_idx
    ON aura_waitlist_requests (customer_id)
    WHERE deleted_at IS NULL
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_waitlist_requests_active_idx
    ON aura_waitlist_requests (status, expires_at)
    WHERE deleted_at IS NULL AND status = 'active'
  `);
  // Expression index must use IMMUTABLE ops — avoid uuid::text casts.
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS aura_waitlist_requests_active_dup_uniq
    ON aura_waitlist_requests (
      customer_id,
      COALESCE(barber_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(service_name, ''),
      COALESCE(preferred_date, DATE '0001-01-01'),
      COALESCE(date_from, DATE '0001-01-01'),
      COALESCE(date_to, DATE '0001-01-01'),
      COALESCE(time_range_start, ''),
      COALESCE(time_range_end, ''),
      any_qualified_barber,
      earliest_available
    )
    WHERE deleted_at IS NULL AND status IN ('active', 'paused', 'pending_consent')
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_waitlist_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID REFERENCES aura_waitlist_requests(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      snapshot JSONB,
      actor TEXT,
      actor_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_waitlist_events_customer_idx
    ON aura_waitlist_events (customer_id, created_at DESC)
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_slot_offers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      waitlist_request_id UUID NOT NULL REFERENCES aura_waitlist_requests(id),
      customer_id UUID NOT NULL,
      barber_id UUID,
      barber_name TEXT,
      service_id TEXT,
      service_name TEXT,
      slot_date DATE NOT NULL,
      slot_time TEXT NOT NULL,
      current_price NUMERIC,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'offered',
      offer_expires_at TIMESTAMPTZ NOT NULL,
      claimed_booking_id UUID,
      claim_token UUID,
      match_score INTEGER,
      match_reasons JSONB,
      idempotency_key TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      audit_metadata JSONB,
      CONSTRAINT aura_slot_offer_status_chk CHECK (status IN (
        'offered', 'accepted_pending_booking', 'declined', 'expired',
        'claimed', 'superseded', 'unavailable'
      ))
    )
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_slot_offers_customer_idx
    ON aura_slot_offers (customer_id, status)
    WHERE deleted_at IS NULL
  `);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS aura_slot_offers_open_slot_uniq
    ON aura_slot_offers (
      COALESCE(barber_id, '00000000-0000-0000-0000-000000000000'::uuid),
      slot_date,
      slot_time,
      COALESCE(service_name, '')
    )
    WHERE deleted_at IS NULL AND status IN ('offered', 'accepted_pending_booking', 'claimed')
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_slot_offer_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      offer_id UUID REFERENCES aura_slot_offers(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      snapshot JSONB,
      actor TEXT,
      actor_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS aura_slot_offer_events_offer_idx
    ON aura_slot_offer_events (offer_id, created_at DESC)
  `);
}

module.exports = { ensureAuraWaitlistTables };
