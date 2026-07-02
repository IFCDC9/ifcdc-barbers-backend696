import { dbQuery } from "./db.js";

let ready = false;

export async function ensureProviderTypeSchema() {
  if (ready) return;
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS provider_type TEXT;`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en';`);
  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS provider_type TEXT DEFAULT 'barber';`);
  await dbQuery(`UPDATE barbers SET provider_type = 'barber' WHERE provider_type IS NULL OR btrim(provider_type) = '';`);
  await dbQuery(`UPDATE app_users SET provider_type = 'barber' WHERE lower(coalesce(role, '')) = 'barber' AND (provider_type IS NULL OR btrim(provider_type) = '');`);
  await dbQuery(`UPDATE app_users SET provider_type = 'shop_owner' WHERE lower(coalesce(role, '')) = 'shop_owner' AND (provider_type IS NULL OR btrim(provider_type) = '');`);
  ready = true;
}
