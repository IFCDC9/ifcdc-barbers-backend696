import { dbQuery } from "../../db.js";

function normalizePhone(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

/** Optional platform-wide fallback when a shop has no `businesses.phone` (set in Render/env). */
export function platformBusinessPhoneFallback() {
  return normalizePhone(process.env.BUSINESS_PHONE);
}

/**
 * Public business line for the website: shop DB phone first, then platform env fallback.
 * @param {string|number|null|undefined} businessId — optional `businesses.id`; else first shop row.
 */
export async function resolvePublicBusinessPhone(businessId = null) {
  const raw = businessId != null && businessId !== "" ? businessId : null;
  const asNum = raw != null ? Number(raw) : NaN;

  try {
    const r =
      Number.isFinite(asNum) && String(asNum) === String(raw).trim()
        ? await dbQuery(`SELECT phone FROM businesses WHERE id = $1::bigint LIMIT 1`, [asNum])
        : await dbQuery(`SELECT phone FROM businesses ORDER BY id ASC LIMIT 1`);

    const shopPhone = normalizePhone(r.rows?.[0]?.phone);
    if (shopPhone) {
      return { phone: shopPhone, source: "shop" };
    }
  } catch (e) {
    console.warn("[publicContactConfig] shop phone lookup failed:", e?.message || e);
  }

  const fallback = platformBusinessPhoneFallback();
  if (fallback) {
    return { phone: fallback, source: "platform_fallback" };
  }

  return { phone: null, source: "none" };
}
