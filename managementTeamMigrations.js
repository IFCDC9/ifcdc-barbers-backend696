/**
 * Management Team schema — multi-manager RBAC with shop/location scope.
 * Boot-time idempotent migration (same pattern as adminShopMigrations).
 */
import { dbQuery } from "./db.js";

let ready = false;

export async function ensureManagementTeamSchema() {
  if (ready) return { ok: true, cached: true };

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS shop_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id BIGINT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Main Location',
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      country TEXT DEFAULT 'US',
      phone TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS shop_locations_business_id_idx ON shop_locations (business_id)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS shop_locations_status_idx ON shop_locations (status)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS management_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      full_access BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      suspended_at TIMESTAMPTZ,
      suspended_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
      removed_at TIMESTAMPTZ,
      removed_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
      CONSTRAINT management_assignments_role_chk
        CHECK (role IN ('platform_manager','shop_manager','location_manager')),
      CONSTRAINT management_assignments_status_chk
        CHECK (status IN ('active','suspended','removed'))
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS management_assignments_user_id_idx ON management_assignments (user_id)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS management_assignments_status_idx ON management_assignments (status)`,
  );
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS management_assignments_one_active_per_user_idx
    ON management_assignments (user_id)
    WHERE status IN ('active','suspended');
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS manager_shop_access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id UUID NOT NULL REFERENCES management_assignments(id) ON DELETE CASCADE,
      business_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assignment_id, business_id)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS manager_shop_access_business_id_idx ON manager_shop_access (business_id)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS manager_shop_access_assignment_id_idx ON manager_shop_access (assignment_id)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS manager_location_access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id UUID NOT NULL REFERENCES management_assignments(id) ON DELETE CASCADE,
      location_id UUID NOT NULL REFERENCES shop_locations(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assignment_id, location_id)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS manager_location_access_location_id_idx ON manager_location_access (location_id)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS manager_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id UUID NOT NULL REFERENCES management_assignments(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assignment_id, permission_key)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS manager_permissions_assignment_id_idx ON manager_permissions (assignment_id)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS management_activity_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_user_id UUID,
      actor_email TEXT,
      actor_assignment_id UUID,
      action TEXT NOT NULL,
      business_id BIGINT,
      location_id UUID,
      record_type TEXT,
      record_id TEXT,
      before_value JSONB,
      after_value JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS management_activity_log_created_at_idx ON management_activity_log (created_at DESC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS management_activity_log_actor_idx ON management_activity_log (actor_user_id)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS management_activity_log_business_idx ON management_activity_log (business_id)`,
  );

  // Durable email link so Management Team survives account delete + re-register / Apple Sign-In.
  await dbQuery(`ALTER TABLE management_assignments ADD COLUMN IF NOT EXISTS linked_email TEXT`);
  await dbQuery(`
    UPDATE management_assignments ma
    SET linked_email = lower(trim(u.email::text))
    FROM app_users u
    WHERE ma.user_id = u.id
      AND (ma.linked_email IS NULL OR btrim(ma.linked_email) = '')
  `);
  await dbQuery(`ALTER TABLE management_assignments ALTER COLUMN user_id DROP NOT NULL`);
  const fk = await dbQuery(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'management_assignments'::regclass
      AND conname = 'management_assignments_user_id_fkey'
  `);
  const fkDef = String(fk.rows?.[0]?.def || "");
  if (!/ON DELETE SET NULL/i.test(fkDef)) {
    await dbQuery(
      `ALTER TABLE management_assignments DROP CONSTRAINT IF EXISTS management_assignments_user_id_fkey`,
    );
    await dbQuery(`
      ALTER TABLE management_assignments
        ADD CONSTRAINT management_assignments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL
    `);
  }
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS management_assignments_linked_email_idx
    ON management_assignments (lower(linked_email))
  `);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS management_assignments_one_active_per_email_idx
    ON management_assignments (lower(linked_email))
    WHERE status IN ('active','suspended')
      AND linked_email IS NOT NULL
      AND btrim(linked_email) <> ''
  `);

  // Backfill one primary location per existing business (idempotent).
  await dbQuery(`
    INSERT INTO shop_locations (business_id, name, address, city, state, is_primary, status)
    SELECT
      b.id,
      COALESCE(NULLIF(TRIM(b.name), ''), 'Main Location'),
      NULLIF(TRIM(COALESCE(b.address, '')), ''),
      NULLIF(TRIM(COALESCE(b.city, '')), ''),
      NULLIF(TRIM(COALESCE(b.state, '')), ''),
      true,
      'active'
    FROM businesses b
    WHERE NOT EXISTS (
      SELECT 1 FROM shop_locations sl WHERE sl.business_id = b.id AND sl.is_primary = true
    );
  `);

  ready = true;
  return { ok: true };
}
