/**
 * Resolve shop tenant keys (text on barbers/app_users) to numeric businesses.id
 * used by bookings.business_id and HubSpot company sync.
 *
 * Historical rows use tenant text "default" / "0" while businesses.id is bigint.
 */
import { dbQuery } from "./db.js";

const DEFAULT_SHOP_NAME = "IFCDC Barbers";

let cachedDefaultShopId = null;

/** Positive bigint business id, or null. */
export function coerceNumericBusinessId(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text === "default" || text === "0") return null; // needs default-shop lookup
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function isLegacyDefaultTenant(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  return text === "default" || text === "0" || text === "";
}

/**
 * Resolve the canonical numeric shop id for legacy tenant keys.
 * Prefer env override, else businesses row named IFCDC Barbers, else id=1 when present.
 */
export async function resolveDefaultShopBusinessId(dbQueryFn = dbQuery) {
  if (cachedDefaultShopId != null) return cachedDefaultShopId;

  const envOverride = coerceNumericBusinessId(process.env.DEFAULT_SHOP_BUSINESS_ID);
  if (envOverride != null) {
    cachedDefaultShopId = envOverride;
    return cachedDefaultShopId;
  }

  try {
    const byName = await dbQueryFn(
      `SELECT id FROM businesses
       WHERE lower(trim(name)) = lower(trim($1))
       ORDER BY id ASC
       LIMIT 1`,
      [DEFAULT_SHOP_NAME],
    );
    const named = coerceNumericBusinessId(byName.rows?.[0]?.id);
    if (named != null) {
      cachedDefaultShopId = named;
      return cachedDefaultShopId;
    }

    const byId = await dbQueryFn(`SELECT id FROM businesses WHERE id = 1 LIMIT 1`);
    const one = coerceNumericBusinessId(byId.rows?.[0]?.id);
    if (one != null) {
      cachedDefaultShopId = one;
      return cachedDefaultShopId;
    }
  } catch (error) {
    console.warn("[businessIdResolve] default shop lookup failed:", error?.message || error);
  }

  return null;
}

/** Clear cache (tests / after seed). */
export function clearDefaultShopBusinessIdCache() {
  cachedDefaultShopId = null;
}

/**
 * Map any barber/shop tenant value to numeric businesses.id.
 * @param {unknown} raw
 * @param {*} [dbQueryFn]
 */
export async function resolveNumericBusinessId(raw, dbQueryFn = dbQuery) {
  const direct = coerceNumericBusinessId(raw);
  if (direct != null) return direct;
  if (isLegacyDefaultTenant(raw)) {
    return resolveDefaultShopBusinessId(dbQueryFn);
  }
  return null;
}

/**
 * Resolve numeric business id for a barber row id.
 * @param {*} dbQueryFn
 * @param {string|number} barberId
 */
export async function resolveNumericBusinessIdForBarber(dbQueryFn, barberId) {
  if (barberId == null || String(barberId).trim() === "") return null;
  const r = await dbQueryFn(`SELECT business_id FROM barbers WHERE id::text = $1 LIMIT 1`, [
    String(barberId),
  ]);
  return resolveNumericBusinessId(r.rows?.[0]?.business_id, dbQueryFn);
}
