/**
 * Safe preferred_language migration for MULTI_LANGUAGE_DROPDOWN_V2.
 * - Ensures column exists (default en)
 * - Does NOT overwrite existing preferences
 * - Normalizes legacy Spanish values to `es`
 * - Leaves unknown values alone (they still fall back to English in UI/email)
 */
import { dbQuery } from "./db.js";

let ready = false;

export async function ensurePreferredLanguageSchema() {
  if (ready) return;
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en'`);
  // Only fill NULL rows — never overwrite an existing preference.
  await dbQuery(
    `UPDATE app_users
     SET preferred_language = 'en'
     WHERE preferred_language IS NULL OR btrim(preferred_language) = ''`,
  );
  // Normalize common Spanish tags without touching other languages.
  await dbQuery(
    `UPDATE app_users
     SET preferred_language = 'es'
     WHERE lower(btrim(preferred_language)) IN ('es', 'es-es', 'es-mx', 'es-419', 'spanish', 'español', 'espanol')`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS app_users_preferred_language_idx ON app_users (preferred_language)`,
  ).catch(() => {});
  ready = true;
}
