import { dbQuery } from "./db.js";
import { getBarbersIdColumnType, getTableBarberIdType } from "./barberScheduleMigrations.js";

export const ALLOWED_ROLES = ["super_admin", "admin", "shop_owner", "barber", "user"];

export async function ensureUsersRoleColumn() {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // App-owned auth table (avoid conflicts with Supabase auth/public.users).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS barber_id BIGINT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS business_id BIGINT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active';`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS date_of_birth DATE;`);
  await dbQuery(`UPDATE app_users SET account_status = 'active' WHERE account_status IS NULL;`);

  // Enforce allowed values via CHECK constraint (idempotent; recreate when shop_owner was missing).
  await dbQuery(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'app_users_role_allowed'
      ) THEN
        ALTER TABLE app_users DROP CONSTRAINT app_users_role_allowed;
      END IF;
      ALTER TABLE app_users
        ADD CONSTRAINT app_users_role_allowed
        CHECK (role IN ('super_admin','admin','shop_owner','barber','user'));
    END $$;
  `);

  // Ensure default exists (older rows may have null role).
  await dbQuery(`UPDATE app_users SET role = 'user' WHERE role IS NULL;`);

  await dbQuery(
    `CREATE INDEX IF NOT EXISTS app_users_business_id_idx ON app_users (business_id) WHERE business_id IS NOT NULL;`,
  );
}

/** When `barbers.id` is UUID, align `app_users.barber_id` so signup provisioning can link accounts. */
export async function ensureAppUsersBarberIdTypeAligned() {
  const barbersType = await getBarbersIdColumnType();
  if (barbersType !== "uuid") return { aligned: false, reason: "barbers_not_uuid" };

  const appType = await getTableBarberIdType("app_users");
  if (appType === "uuid") return { aligned: true, already: true };
  if (!appType) {
    await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS barber_id UUID`);
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS app_users_barber_id_idx ON app_users (barber_id) WHERE barber_id IS NOT NULL`,
    );
    return { aligned: true, created: true };
  }

  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS barber_id_uuid UUID`);
  await dbQuery(`
    UPDATE app_users u
    SET barber_id_uuid = b.id
    FROM barbers b
    WHERE b.user_id = u.id AND u.barber_id_uuid IS NULL
  `);
  if (appType === "bigint" || appType === "integer") {
    await dbQuery(`ALTER TABLE app_users DROP COLUMN IF EXISTS barber_id`);
  }
  await dbQuery(`ALTER TABLE app_users RENAME COLUMN barber_id_uuid TO barber_id`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS app_users_barber_id_idx ON app_users (barber_id) WHERE barber_id IS NOT NULL`,
  );
  return { aligned: true, converted: true };
}

/** Admin onboarding invites — pending users until they accept and complete signup. */
export async function ensurePendingInvitesTable() {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS pending_user_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invite_token TEXT NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      phone TEXT,
      role VARCHAR NOT NULL DEFAULT 'user',
      business_id BIGINT,
      welcome_note TEXT,
      status VARCHAR NOT NULL DEFAULT 'pending',
      onboarding_state VARCHAR NOT NULL DEFAULT 'invite_pending',
      send_email BOOLEAN NOT NULL DEFAULT true,
      send_sms BOOLEAN NOT NULL DEFAULT false,
      invited_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS pending_user_invites_email_idx
    ON pending_user_invites (lower(trim(email)));
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS pending_user_invites_status_idx
    ON pending_user_invites (status);
  `);
}

/** Admin password recovery flags on app_users. */
export async function ensurePasswordRecoveryColumns() {
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false;`);
  await dbQuery(`UPDATE app_users SET force_password_change = false WHERE force_password_change IS NULL;`);
}

/** Google Sign-In: stable link on `app_users` (Postgres). Safe to run every boot. */
export async function ensureGoogleAuthSupport() {
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS google_id TEXT;`);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_google_id_ux
    ON app_users (google_id)
    WHERE google_id IS NOT NULL AND btrim(google_id) <> '';
  `);
}

/** Sign in with Apple: stable link on `app_users`. Safe to run every boot. */
export async function ensureAppleAuthSupport() {
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS apple_id TEXT;`);
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_apple_id_ux
    ON app_users (apple_id)
    WHERE apple_id IS NOT NULL AND btrim(apple_id) <> '';
  `);
}

