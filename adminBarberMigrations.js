import { dbQuery } from "./db.js";

let ready = false;

/**
 * Schema for global barber management (super admin + shop-scoped owners).
 */
export async function ensureAdminBarberManagementSchema() {
  if (ready) return;
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS businesses (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      plan TEXT DEFAULT 'free',
      subscription_status TEXT DEFAULT 'inactive',
      city TEXT,
      state TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'pending';`);
  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS booking_hidden BOOLEAN DEFAULT false;`);
  await dbQuery(
    `UPDATE barbers SET booking_hidden = false WHERE booking_hidden IS NULL;`,
  );
  await dbQuery(
    `UPDATE barbers SET verification_status = 'approved' WHERE verification_status IS NULL OR btrim(verification_status) = '';`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS admin_user_notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      kind TEXT NOT NULL DEFAULT 'barber_registered',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload JSONB,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS admin_user_notifications_user_idx ON admin_user_notifications (user_id, created_at DESC);`,
  );

  ready = true;
}
