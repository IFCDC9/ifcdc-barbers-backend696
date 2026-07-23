/**
 * Resolve customer-facing language for emails / notifications.
 * Order: explicit hint → app_users.preferred_language → barber settings → en
 * Admin operational emails should pass language: "en" explicitly.
 */
import { dbQuery } from "./db.js";
import { normalizePreferredLanguage } from "./shared/multiLanguageFlag.js";

export async function resolveCustomerLanguage({
  userId = null,
  customerEmail = null,
  explicitLanguage = null,
  barberLanguage = null,
} = {}) {
  const fromExplicit = normalizePreferredLanguage(explicitLanguage, { allowV2: true });
  if (fromExplicit) return fromExplicit;

  try {
    if (userId) {
      const r = await dbQuery(
        `SELECT preferred_language FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [String(userId)],
      );
      const hit = normalizePreferredLanguage(r.rows?.[0]?.preferred_language, { allowV2: true });
      if (hit) return hit;
    }
    if (customerEmail) {
      const r = await dbQuery(
        `SELECT preferred_language FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
        [String(customerEmail)],
      );
      const hit = normalizePreferredLanguage(r.rows?.[0]?.preferred_language, { allowV2: true });
      if (hit) return hit;
    }
  } catch {
    /* fall through */
  }

  const fromBarber = normalizePreferredLanguage(barberLanguage, { allowV2: true });
  if (fromBarber) return fromBarber;
  return "en";
}
