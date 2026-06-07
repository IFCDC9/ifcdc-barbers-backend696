/**
 * Unified public booking styles — merges barber_services (UUID barbers) with legacy `styles` rows.
 */
const { isUuidBarberId, coerceBarberIdForTable } = require("./barberIdentity.cjs");
const { normalizePublishedImageUrl } = require("./styleImageUrl.cjs");

const SERVICE_ID_PREFIX = "svc-";

function serviceStyleId(serviceId) {
  return `${SERVICE_ID_PREFIX}${serviceId}`;
}

function parseServiceStyleId(styleId) {
  const raw = String(styleId || "").trim();
  if (!raw.startsWith(SERVICE_ID_PREFIX)) return null;
  const n = Number(raw.slice(SERVICE_ID_PREFIX.length));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mapServiceRow(row) {
  if (!row) return null;
  const imageUrl = normalizePublishedImageUrl(row.image_url, {
    styleId: serviceStyleId(row.id),
    barberId: row.barber_id,
    serviceId: row.id,
  });
  return {
    id: serviceStyleId(row.id),
    barber_id: row.barber_id,
    title: String(row.name || "").trim() || "Service",
    description: row.description || "",
    image_url: imageUrl,
    category: String(row.category || "other").trim() || "other",
    price: Number(row.price),
    duration_minutes: Number(row.duration_minutes) || 30,
    is_published: row.is_active !== false,
    source: "barber_service",
    service_id: row.id,
  };
}

function mapLegacyStyleRow(row) {
  if (!row) return null;
  const published = row.is_published !== false;
  if (!published) return null;
  const imageUrl = normalizePublishedImageUrl(row.image_url, {
    styleId: String(row.id),
    barberId: row.barber_id,
  });
  return {
    id: String(row.id),
    barber_id: row.barber_id,
    title: String(row.title || "").trim() || "Style",
    description: row.description || "",
    image_url: imageUrl,
    category: String(row.category || "other").trim() || "other",
    price: Number(row.price),
    duration_minutes: 30,
    is_published: true,
    source: "styles",
    service_id: null,
  };
}

/**
 * All published bookable styles for the website / mobile style picker.
 */
async function listAllPublishedBookingStyles(dbQuery) {
  const out = [];

  try {
    const svc = await dbQuery(
      `SELECT s.id, s.barber_id, s.name, s.description, s.category, s.icon, s.image_url,
              s.price::float8 AS price, s.duration_minutes, s.is_active,
              b.name AS barber_name
       FROM barber_services s
       INNER JOIN barbers b ON b.id::text = s.barber_id::text
       WHERE s.is_active = true
       ORDER BY lower(b.name) ASC, s.id ASC
       LIMIT 2000`,
    );
    for (const row of svc.rows || []) {
      const mapped = mapServiceRow(row);
      if (mapped) out.push(mapped);
    }
  } catch (e) {
    console.warn("[styles] barber_services list:", e?.message || e);
  }

  try {
    const legacy = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price,
              COALESCE(is_published, true) AS is_published
       FROM styles
       WHERE COALESCE(is_published, true) = true
       ORDER BY created_at DESC
       LIMIT 500`,
    );
    for (const row of legacy.rows || []) {
      const mapped = mapLegacyStyleRow(row);
      if (mapped) out.push(mapped);
    }
  } catch (e) {
    console.warn("[styles] legacy styles list:", e?.message || e);
  }

  return out;
}

/** All bookable styles including unpublished (admin / barber dashboard). */
async function listAllBookingStylesForAdmin(dbQuery) {
  const out = [];

  try {
    const svc = await dbQuery(
      `SELECT s.id, s.barber_id, s.name, s.description, s.category, s.icon, s.image_url,
              s.price::float8 AS price, s.duration_minutes, s.is_active,
              b.name AS barber_name
       FROM barber_services s
       INNER JOIN barbers b ON b.id::text = s.barber_id::text
       ORDER BY lower(b.name) ASC, s.id ASC
       LIMIT 2000`,
    );
    for (const row of svc.rows || []) {
      const mapped = mapServiceRow(row);
      if (mapped) out.push(mapped);
    }
  } catch (e) {
    console.warn("[styles] barber_services admin list:", e?.message || e);
  }

  try {
    const legacy = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price,
              COALESCE(is_published, true) AS is_published
       FROM styles
       ORDER BY created_at DESC
       LIMIT 500`,
    );
    for (const row of legacy.rows || []) {
      const mapped = mapLegacyStyleRow({ ...row, is_published: row.is_published });
      if (mapped) out.push(mapped);
      else if (row) {
        out.push({
          id: String(row.id),
          barber_id: row.barber_id,
          title: String(row.title || "").trim() || "Style",
          description: row.description || "",
          image_url: String(row.image_url || "").trim() || "https://ifcdcbarbersapp.com/icon-512.png",
          category: String(row.category || "other").trim() || "other",
          price: Number(row.price),
          duration_minutes: 30,
          is_published: row.is_published !== false,
          source: "legacy_style",
        });
      }
    }
  } catch (e) {
    console.warn("[styles] legacy admin list:", e?.message || e);
  }

  return out;
}

/**
 * Published styles for one barber (UUID or numeric id).
 */
async function listPublishedBookingStylesForBarber(dbQuery, barberIdRaw) {
  const idText = String(barberIdRaw || "").trim();
  if (!idText) return [];

  const all = await listAllPublishedBookingStyles(dbQuery);
  return all.filter((s) => String(s.barber_id) === idText);
}

/**
 * Resolve a booking style for checkout — supports svc-{id} and legacy UUID.
 */
async function resolveBookingStyleRow(dbQuery, styleId, barberIdRaw) {
  const sid = String(styleId || "").trim();
  if (!sid) return null;

  const serviceId = parseServiceStyleId(sid);
  if (serviceId != null) {
    const r = await dbQuery(
      `SELECT id, barber_id, name, description, category, icon, image_url,
              price::float8 AS price, duration_minutes, is_active
       FROM barber_services
       WHERE id = $1 AND is_active = true
       LIMIT 1`,
      [serviceId],
    );
    const mapped = mapServiceRow(r.rows?.[0]);
    if (!mapped) return null;
    if (barberIdRaw != null && String(barberIdRaw).trim() !== "") {
      if (String(mapped.barber_id) !== String(barberIdRaw).trim()) return null;
    }
    return mapped;
  }

  try {
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price,
              COALESCE(is_published, true) AS is_published
       FROM styles
       WHERE id = $1::uuid
       LIMIT 1`,
      [sid],
    );
    const mapped = mapLegacyStyleRow(r.rows?.[0]);
    if (!mapped) return null;
    if (barberIdRaw != null && String(barberIdRaw).trim() !== "") {
      if (String(mapped.barber_id) !== String(barberIdRaw).trim()) return null;
    }
    return mapped;
  } catch {
    return null;
  }
}

/**
 * Insert or update barber_services row from admin style form (UUID barbers).
 */
async function upsertBarberServiceStyle(dbQuery, {
  barberId,
  name,
  description = "",
  category = "other",
  price = 25,
  durationMinutes = 30,
  imageUrl = "",
  isActive = true,
  serviceId = null,
}) {
  const barberKey = await coerceBarberIdForTable(dbQuery, "barber_services", barberId);
  if (barberKey == null) throw new Error("invalid_barber_id");

  const title = String(name || "").trim();
  if (!title) throw new Error("title_required");
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("invalid_price");
  const dur = Number(durationMinutes);
  const duration = Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 30;

  if (serviceId != null) {
    const sid = Number(serviceId);
    const r = await dbQuery(
      `UPDATE barber_services SET
         name = $2,
         description = COALESCE($3, description),
         category = COALESCE($4, category),
         price = $5,
         duration_minutes = $6,
         image_url = CASE WHEN $7::text <> '' THEN $7 ELSE image_url END,
         is_active = COALESCE($8, is_active)
       WHERE id = $1 AND barber_id::text = $9::text
       RETURNING id, barber_id, name, description, category, icon, image_url,
                 price::float8 AS price, duration_minutes, is_active`,
      [sid, title, description || null, category || null, p, duration, String(imageUrl || ""), isActive, String(barberKey)],
    );
    if (r.rows?.length) return mapServiceRow(r.rows[0]);
    throw new Error("not_found");
  }

  let business_id = null;
  try {
    const br = await dbQuery(`SELECT business_id FROM barbers WHERE id::text = $1::text LIMIT 1`, [String(barberKey)]);
    const biz = br.rows?.[0]?.business_id;
    if (biz != null && biz !== "") business_id = Number(biz);
    if (!Number.isFinite(business_id)) business_id = null;
  } catch {
    /* optional column */
  }

  const ins = await dbQuery(
    `INSERT INTO barber_services (barber_id, business_id, name, description, category, image_url, price, duration_minutes, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, barber_id, name, description, category, icon, image_url,
               price::float8 AS price, duration_minutes, is_active`,
    [barberKey, business_id, title, description || null, category || null, String(imageUrl || "") || null, p, duration, Boolean(isActive)],
  );
  return mapServiceRow(ins.rows?.[0]);
}

async function setBarberServicePublished(dbQuery, styleId, published) {
  const serviceId = parseServiceStyleId(styleId) ?? Number(styleId);
  if (!Number.isFinite(serviceId) || serviceId <= 0) throw new Error("invalid_style_id");
  const r = await dbQuery(
    `UPDATE barber_services SET is_active = $2 WHERE id = $1
     RETURNING id, barber_id, name, description, category, icon, image_url,
               price::float8 AS price, duration_minutes, is_active`,
    [serviceId, Boolean(published)],
  );
  if (!r.rows?.length) throw new Error("not_found");
  return mapServiceRow(r.rows[0]);
}

module.exports = {
  SERVICE_ID_PREFIX,
  serviceStyleId,
  parseServiceStyleId,
  mapServiceRow,
  listAllPublishedBookingStyles,
  listAllBookingStylesForAdmin,
  listPublishedBookingStylesForBarber,
  resolveBookingStyleRow,
  upsertBarberServiceStyle,
  setBarberServicePublished,
};
