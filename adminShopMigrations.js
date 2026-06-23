import { dbQuery } from "./db.js";

let ready = false;

/** Schema for global shop management (super admin + shop-scoped owners). */
export async function ensureAdminShopManagementSchema() {
  if (ready) return;
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active';`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await dbQuery(
    `UPDATE businesses SET account_status = 'active' WHERE account_status IS NULL OR btrim(account_status) = '';`,
  );
  ready = true;
}
