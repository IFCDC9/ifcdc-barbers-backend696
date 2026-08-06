/**
 * Live DB adapters for Phase 3A knowledge — never invent values.
 * Returns structured public facts only (no credentials / PII).
 */
const defaultDb = require("./db.js");

function pickQuery(opts) {
  if (opts && typeof opts.dbQuery === "function") return opts.dbQuery;
  return defaultDb.dbQuery;
}

async function liveServicesCatalog(opts = {}) {
  const dbQuery = pickQuery(opts);
  const shopId = opts.shopId ?? opts.businessId ?? null;
  if (shopId == null || !Number.isFinite(Number(shopId))) {
    return { ok: false, reason: "shop_required", facts: [] };
  }
  const params = [Number(shopId)];
  let sql = `
    SELECT DISTINCT ON (lower(btrim(s.name)))
           s.name, s.description, s.price::float AS price, s.duration_minutes
    FROM barber_services s
    JOIN barbers b ON b.id::text = s.barber_id::text
    WHERE b.business_id = $1::bigint
      AND coalesce(s.is_active, true) = true
      AND s.name IS NOT NULL AND btrim(s.name) <> ''
  `;
  if (opts.barberId) {
    params.push(String(opts.barberId));
    sql += ` AND s.barber_id::text = $${params.length}`;
  }
  sql += ` ORDER BY lower(btrim(s.name)), s.created_at DESC NULLS LAST LIMIT 40`;
  const r = await dbQuery(sql, params);
  const rows = r.rows || [];
  if (!rows.length) {
    return { ok: false, reason: "no_active_services", facts: [] };
  }
  return {
    ok: true,
    facts: rows.map((row) => ({
      name: row.name,
      description: row.description || null,
      price: Number.isFinite(Number(row.price)) ? Number(row.price) : null,
      durationMinutes: Number(row.duration_minutes) || null,
    })),
    summary: rows
      .map((row) => {
        const price = Number.isFinite(Number(row.price)) ? `$${Number(row.price).toFixed(2)}` : "price TBA";
        const dur = row.duration_minutes ? `${row.duration_minutes} min` : "duration TBA";
        return `${row.name}: ${price}, ${dur}`;
      })
      .join("; "),
  };
}

async function liveBarberProfiles(opts = {}) {
  const dbQuery = pickQuery(opts);
  const shopId = opts.shopId ?? opts.businessId ?? null;
  if (shopId == null || !Number.isFinite(Number(shopId))) {
    return { ok: false, reason: "shop_required", facts: [] };
  }
  const r = await dbQuery(
    `SELECT b.id::text AS id, b.name, b.bio, b.location
     FROM barbers b
     WHERE b.business_id = $1::bigint
       AND b.name IS NOT NULL AND btrim(b.name) <> ''
     ORDER BY b.name ASC
     LIMIT 40`,
    [Number(shopId)],
  );
  const rows = r.rows || [];
  if (!rows.length) return { ok: false, reason: "no_active_barbers", facts: [] };
  return {
    ok: true,
    facts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      specialty: null,
      location: row.location || null,
      bio: row.bio ? String(row.bio).slice(0, 280) : null,
    })),
    summary: rows.map((row) => row.name).join("; "),
  };
}

async function liveShopLocation(opts = {}) {
  const dbQuery = pickQuery(opts);
  const shopId = opts.shopId ?? opts.businessId ?? null;
  if (shopId == null || !Number.isFinite(Number(shopId))) {
    return { ok: false, reason: "shop_required", facts: [] };
  }
  const r = await dbQuery(
    `SELECT name, address, city, state, phone, public_phone_e164
     FROM businesses
     WHERE id = $1::bigint
     LIMIT 1`,
    [Number(shopId)],
  );
  const rows = r.rows || [];
  if (!rows.length) {
    return { ok: false, reason: "no_business_location", facts: [] };
  }
  const facts = rows.map((row) => ({
    name: row.name,
    address: [row.address, row.city, row.state].filter(Boolean).join(", "),
    phone: row.public_phone_e164 || row.phone || null,
  }));
  return {
    ok: true,
    facts,
    summary: facts
      .map((f) => [f.name, f.address, f.phone].filter(Boolean).join(" — "))
      .join("; "),
  };
}

async function liveBusinessHours(opts = {}) {
  const dbQuery = pickQuery(opts);
  const shopId = opts.shopId ?? opts.businessId ?? null;
  if (shopId == null || !Number.isFinite(Number(shopId))) {
    return { ok: false, reason: "shop_required", facts: [] };
  }

  const shopHours = await dbQuery(
    `SELECT name, operating_hours_json, holiday_hours_json, temporary_closed, temporary_closed_reason
     FROM businesses WHERE id = $1::bigint LIMIT 1`,
    [Number(shopId)],
  );
  const shop = shopHours.rows?.[0];
  if (shop?.temporary_closed) {
    return {
      ok: true,
      facts: [{ closed: true, reason: shop.temporary_closed_reason || "Temporarily closed" }],
      summary: `${shop.name || "Shop"} is temporarily closed${
        shop.temporary_closed_reason ? `: ${shop.temporary_closed_reason}` : ""
      }`,
    };
  }
  if (shop?.operating_hours_json?.note) {
    return {
      ok: true,
      facts: [{ hours: shop.operating_hours_json.note }],
      summary: String(shop.operating_hours_json.note),
    };
  }

  // Aggregate distinct open windows from barber_settings for this shop only.
  const r = await dbQuery(
    `SELECT b.name AS barber_name, s.availability, s.timezone
     FROM barber_settings s
     JOIN barbers b ON b.id::text = s.barber_id::text
     WHERE b.business_id = $1::bigint
       AND coalesce(b.is_active, true) = true
     LIMIT 20`,
    [Number(shopId)],
  );
  const rows = r.rows || [];
  if (!rows.length) return { ok: false, reason: "no_schedule_rows", facts: [] };

  const facts = [];
  for (const row of rows) {
    let availability = row.availability;
    if (typeof availability === "string") {
      try {
        availability = JSON.parse(availability);
      } catch {
        availability = null;
      }
    }
    if (!Array.isArray(availability) || !availability.length) continue;
    const openDays = availability
      .filter((d) => d && !d.is_off && (d.open || d.start))
      .map((d) => {
        const day = d.day || d.weekday || d.name || "day";
        const open = d.open || d.start || "?";
        const close = d.close || d.end || "?";
        return `${day} ${open}–${close}`;
      });
    if (openDays.length) {
      facts.push({
        barberName: row.barber_name,
        timezone: row.timezone || process.env.SHOP_TIMEZONE || "America/New_York",
        hours: openDays,
      });
    }
  }
  if (!facts.length) return { ok: false, reason: "no_open_hours_configured", facts: [] };
  return {
    ok: true,
    facts,
    summary: facts
      .map((f) => `${f.barberName} (${f.timezone}): ${f.hours.join(", ")}`)
      .join(" | "),
  };
}

async function resolveLiveQuery(liveQueryKey, opts = {}) {
  const key = String(liveQueryKey || "").trim();
  switch (key) {
    case "services_catalog":
      return liveServicesCatalog(opts);
    case "barber_profiles":
      return liveBarberProfiles(opts);
    case "shop_location":
      return liveShopLocation(opts);
    case "business_hours":
      return liveBusinessHours(opts);
    default:
      return { ok: false, reason: "unknown_live_query_key", facts: [] };
  }
}

module.exports = {
  liveServicesCatalog,
  liveBarberProfiles,
  liveShopLocation,
  liveBusinessHours,
  resolveLiveQuery,
};
