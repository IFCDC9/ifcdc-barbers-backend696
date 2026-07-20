import { dbQuery } from "./db.js";

/**
 * HubSpot sync mapping tables (Phase 1 contacts + Phase 2+ stubs).
 * Idempotent — safe to run on every boot.
 */
export async function ensureHubSpotSchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS hubspot_sync_contacts (
      user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      hubspot_contact_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_sync_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS hubspot_sync_contacts_email_uidx
     ON hubspot_sync_contacts (LOWER(email));`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS hubspot_sync_contacts_hubspot_id_idx
     ON hubspot_sync_contacts (hubspot_contact_id)
     WHERE hubspot_contact_id IS NOT NULL;`,
  );

  // Phase 2A — companies (barbershops). BIGINT matches businesses.id (BIGSERIAL).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS hubspot_sync_companies (
      business_id BIGINT PRIMARY KEY,
      hubspot_company_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_sync_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Upgrade legacy INTEGER PK if the stub table already existed.
  await dbQuery(`
    DO $$ BEGIN
      ALTER TABLE hubspot_sync_companies
        ALTER COLUMN business_id TYPE BIGINT
        USING business_id::bigint;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `).catch(() => {});
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS hubspot_sync_companies_hubspot_id_idx
     ON hubspot_sync_companies (hubspot_company_id)
     WHERE hubspot_company_id IS NOT NULL;`,
  ).catch(() => {});

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS hubspot_sync_deals (
      booking_id UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
      hubspot_deal_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_sync_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS hubspot_sync_deals_hubspot_id_idx
     ON hubspot_sync_deals (hubspot_deal_id)
     WHERE hubspot_deal_id IS NOT NULL;`,
  ).catch(() => {});

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS hubspot_sync_entities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type TEXT NOT NULL,
      local_id TEXT NOT NULL,
      hubspot_object_type TEXT,
      hubspot_object_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_sync_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, local_id)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS hubspot_sync_entities_type_idx
     ON hubspot_sync_entities (entity_type, last_sync_status);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS hubspot_sync_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type TEXT NOT NULL,
      local_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS hubspot_sync_events_created_idx
     ON hubspot_sync_events (created_at DESC);`,
  );
}
