/**
 * Unlimited per-barber style photo gallery (UUID barbers).
 * Public booking ids use prefix gal-{uuid}.
 */
const { resolvePublishedImageUrl } = require("./styleImageUrl.cjs");
const {
  GALLERY_ID_PREFIX,
  MAX_STYLE_GALLERY_PHOTOS_PER_BARBER,
} = require("./styleGalleryConstants.cjs");

function galleryStyleId(rowId) {
  return `${GALLERY_ID_PREFIX}${String(rowId || "").trim()}`;
}

function parseGalleryStyleId(styleId) {
  const raw = String(styleId || "").trim();
  if (!raw.startsWith(GALLERY_ID_PREFIX)) return null;
  const id = raw.slice(GALLERY_ID_PREFIX.length).trim();
  return id || null;
}

function mapGalleryRow(row, { includeUnpublished = false } = {}) {
  if (!row) return null;
  const published = row.is_published !== false;
  if (!published && !includeUnpublished) return null;
  const imageUrl = resolvePublishedImageUrl(row.image_url, {
    styleId: galleryStyleId(row.id),
    barberId: row.barber_id,
  });
  return {
    id: galleryStyleId(row.id),
    gallery_id: row.id,
    barber_id: row.barber_id,
    service_id: row.service_id ?? null,
    title: String(row.title || "").trim() || "Style",
    description: row.description || "",
    image_url: imageUrl,
    category: String(row.category || "other").trim() || "other",
    price: Number(row.price),
    duration_minutes: Number(row.duration_minutes) || 30,
    sort_order: Number(row.sort_order) || 0,
    is_published: published,
    source: "barber_style_gallery",
    created_at: row.created_at,
  };
}

async function ensureBarberStyleGalleryTable(dbQuery) {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_style_gallery (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      barber_id TEXT NOT NULL,
      service_id INTEGER REFERENCES barber_services(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'other',
      price NUMERIC(10,2) NOT NULL DEFAULT 25,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      image_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_published BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS barber_style_gallery_barber_sort_idx
    ON barber_style_gallery (barber_id, sort_order ASC, created_at ASC);
  `);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS barber_style_gallery_published_idx
    ON barber_style_gallery (barber_id)
    WHERE is_published = true;
  `);
}

async function countGalleryForBarber(dbQuery, barberId) {
  const r = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM barber_style_gallery WHERE barber_id = $1`,
    [String(barberId || "").trim()],
  );
  return r.rows?.[0]?.n ?? 0;
}

async function nextGallerySortOrder(dbQuery, barberId) {
  const r = await dbQuery(
    `SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS n
     FROM barber_style_gallery WHERE barber_id = $1`,
    [String(barberId || "").trim()],
  );
  return r.rows?.[0]?.n ?? 0;
}

/** Resolve production barber UUID from display name (for legacy upload routes). */
async function resolveBarberUuidByName(dbQuery, barberName) {
  const name = String(barberName || "").trim();
  if (!name) return null;
  const r = await dbQuery(
    `SELECT id::text AS id FROM barbers WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`,
    [name],
  );
  return r.rows?.[0]?.id ? String(r.rows[0].id).trim() : null;
}

/** Published gallery image URLs for barber cards / admin previews. */
async function listGalleryImageUrlsForBarber(dbQuery, barberId) {
  const key = String(barberId || "").trim();
  if (!key) return [];
  const r = await dbQuery(
    `SELECT image_url FROM barber_style_gallery
     WHERE barber_id = $1 AND is_published = true
     ORDER BY sort_order ASC, created_at ASC
     LIMIT 500`,
    [key],
  );
  return (r.rows || [])
    .map((row) => resolvePublishedImageUrl(row.image_url, { barberId: key }))
    .filter(Boolean);
}

async function insertGalleryImage(
  dbQuery,
  {
    barberId,
    title,
    description = "",
    category = "other",
    price = 25,
    durationMinutes = 30,
    imageUrl,
    serviceId = null,
    isPublished = true,
  },
) {
  const barberKey = String(barberId || "").trim();
  if (!barberKey) throw new Error("invalid_barber_id");
  const t = String(title || "").trim();
  if (!t) throw new Error("title_required");
  const url = String(imageUrl || "").trim();
  if (!url) throw new Error("image_required");

  const count = await countGalleryForBarber(dbQuery, barberKey);
  if (count >= MAX_STYLE_GALLERY_PHOTOS_PER_BARBER) {
    throw new Error("gallery_limit_reached");
  }

  const p = Number(price);
  const priceVal = Number.isFinite(p) && p > 0 ? Math.round(p * 100) / 100 : 25;
  const dur = Number(durationMinutes);
  const duration = Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 30;
  const sortOrder = await nextGallerySortOrder(dbQuery, barberKey);

  let linkedServiceId = null;
  if (serviceId != null) {
    const sid = Number(serviceId);
    if (Number.isFinite(sid) && sid > 0) linkedServiceId = sid;
  }

  const ins = await dbQuery(
    `INSERT INTO barber_style_gallery
       (barber_id, service_id, title, description, category, price, duration_minutes,
        image_url, sort_order, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, barber_id, service_id, title, description, category,
               price::float8 AS price, duration_minutes, image_url, sort_order,
               is_published, created_at`,
    [
      barberKey,
      linkedServiceId,
      t,
      description || null,
      category || "other",
      priceVal,
      duration,
      url,
      sortOrder,
      Boolean(isPublished),
    ],
  );
  const mapped = mapGalleryRow(ins.rows?.[0], { includeUnpublished: true });
  if (!mapped?.id) throw new Error("gallery_persist_failed");

  const verify = await dbQuery(
    `SELECT id FROM barber_style_gallery WHERE id = $1::uuid AND barber_id = $2 LIMIT 1`,
    [parseGalleryStyleId(mapped.id), barberKey],
  );
  if (!verify.rows?.length) throw new Error("gallery_persist_failed");
  return mapped;
}

async function listPublishedGalleryStyles(dbQuery) {
  const r = await dbQuery(
    `SELECT id, barber_id, service_id, title, description, category,
            price::float8 AS price, duration_minutes, image_url, sort_order,
            is_published, created_at
     FROM barber_style_gallery
     WHERE is_published = true
     ORDER BY barber_id ASC, sort_order ASC, created_at ASC
     LIMIT 5000`,
  );
  const out = [];
  for (const row of r.rows || []) {
    const mapped = mapGalleryRow(row);
    if (mapped) out.push(mapped);
  }
  return out;
}

async function listAllGalleryStylesForAdmin(dbQuery) {
  const r = await dbQuery(
    `SELECT id, barber_id, service_id, title, description, category,
            price::float8 AS price, duration_minutes, image_url, sort_order,
            is_published, created_at
     FROM barber_style_gallery
     ORDER BY barber_id ASC, sort_order ASC, created_at ASC
     LIMIT 5000`,
  );
  return (r.rows || [])
    .map((row) => mapGalleryRow(row, { includeUnpublished: true }))
    .filter(Boolean);
}

async function listGalleryStylesForBarber(dbQuery, barberIdRaw, { admin = false } = {}) {
  const idText = String(barberIdRaw || "").trim();
  if (!idText) return [];
  const r = await dbQuery(
    `SELECT id, barber_id, service_id, title, description, category,
            price::float8 AS price, duration_minutes, image_url, sort_order,
            is_published, created_at
     FROM barber_style_gallery
     WHERE barber_id = $1
     ${admin ? "" : "AND is_published = true"}
     ORDER BY sort_order ASC, created_at ASC
     LIMIT 5000`,
    [idText],
  );
  return (r.rows || [])
    .map((row) => mapGalleryRow(row, { includeUnpublished: admin }))
    .filter(Boolean);
}

async function resolveGalleryStyleRow(dbQuery, styleId, barberIdRaw) {
  const gid = parseGalleryStyleId(styleId);
  if (!gid) return null;
  const r = await dbQuery(
    `SELECT id, barber_id, service_id, title, description, category,
            price::float8 AS price, duration_minutes, image_url, sort_order,
            is_published, created_at
     FROM barber_style_gallery
     WHERE id = $1::uuid
     LIMIT 1`,
    [gid],
  );
  const mapped = mapGalleryRow(r.rows?.[0], { includeUnpublished: true });
  if (!mapped) return null;
  if (barberIdRaw != null && String(barberIdRaw).trim() !== "") {
    if (String(mapped.barber_id) !== String(barberIdRaw).trim()) return null;
  }
  if (!mapped.is_published) return null;
  return mapped;
}

async function resolveGalleryStyleRowAdmin(dbQuery, styleId) {
  const gid = parseGalleryStyleId(styleId);
  if (!gid) return null;
  const r = await dbQuery(
    `SELECT id, barber_id, service_id, title, description, category,
            price::float8 AS price, duration_minutes, image_url, sort_order,
            is_published, created_at
     FROM barber_style_gallery
     WHERE id = $1::uuid
     LIMIT 1`,
    [gid],
  );
  return mapGalleryRow(r.rows?.[0], { includeUnpublished: true });
}

async function updateGalleryMetadata(dbQuery, styleId, patch = {}) {
  const existing = await resolveGalleryStyleRowAdmin(dbQuery, styleId);
  if (!existing) throw new Error("not_found");
  const gid = parseGalleryStyleId(styleId);

  const title = patch.title != null ? String(patch.title).trim() : null;
  const description = patch.description != null ? String(patch.description).trim() : null;
  const category = patch.category != null ? String(patch.category).trim() : null;
  const price =
    patch.price != null
      ? (() => {
          const n = Number(patch.price);
          return Number.isFinite(n) && n > 0 ? Math.round(n * 100) /  100 : null;
        })()
      : null;
  const isPublished = patch.is_published ?? patch.isPublished;

  const r = await dbQuery(
    `UPDATE barber_style_gallery SET
       title = COALESCE($2, title),
       description = COALESCE($3, description),
       category = COALESCE($4, category),
       price = COALESCE($5, price),
       is_published = CASE WHEN $6::boolean IS NULL THEN is_published ELSE $6::boolean END
     WHERE id = $1::uuid
     RETURNING id, barber_id, service_id, title, description, category,
               price::float8 AS price, duration_minutes, image_url, sort_order,
               is_published, created_at`,
    [gid, title, description, category, price, isPublished == null ? null : Boolean(isPublished)],
  );
  return mapGalleryRow(r.rows?.[0], { includeUnpublished: true });
}

async function updateGalleryImageUrl(dbQuery, styleId, imageUrl) {
  const gid = parseGalleryStyleId(styleId);
  if (!gid) throw new Error("not_found");
  const url = String(imageUrl || "").trim();
  if (!url) throw new Error("image_required");
  const r = await dbQuery(
    `UPDATE barber_style_gallery SET image_url = $2 WHERE id = $1::uuid
     RETURNING id, barber_id, service_id, title, description, category,
               price::float8 AS price, duration_minutes, image_url, sort_order,
               is_published, created_at`,
    [gid, url],
  );
  if (!r.rows?.length) throw new Error("not_found");
  return mapGalleryRow(r.rows[0], { includeUnpublished: true });
}

async function setGalleryPublished(dbQuery, styleId, published) {
  const gid = parseGalleryStyleId(styleId);
  if (!gid) throw new Error("invalid_style_id");
  const r = await dbQuery(
    `UPDATE barber_style_gallery SET is_published = $2 WHERE id = $1::uuid
     RETURNING id, barber_id, service_id, title, description, category,
               price::float8 AS price, duration_minutes, image_url, sort_order,
               is_published, created_at`,
    [gid, Boolean(published)],
  );
  if (!r.rows?.length) throw new Error("not_found");
  return mapGalleryRow(r.rows[0], { includeUnpublished: true });
}

async function deleteGalleryStyle(dbQuery, styleId) {
  const gid = parseGalleryStyleId(styleId);
  if (!gid) throw new Error("invalid_style_id");
  const existing = await dbQuery(
    `SELECT id, image_url FROM barber_style_gallery WHERE id = $1::uuid LIMIT 1`,
    [gid],
  );
  const row = existing.rows?.[0];
  if (!row) throw new Error("not_found");
  await dbQuery(`DELETE FROM barber_style_gallery WHERE id = $1::uuid`, [gid]);
  return { deletedId: galleryStyleId(gid), image_url: row.image_url || "" };
}

async function reorderGalleryStyles(dbQuery, barberId, orderedIds) {
  const barberKey = String(barberId || "").trim();
  if (!barberKey) throw new Error("invalid_barber_id");
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  const galleryIds = ids
    .map((id) => parseGalleryStyleId(id))
    .filter(Boolean);
  if (!galleryIds.length) return { updated: 0 };

  let order = 0;
  for (const rawId of ids) {
    const gid = parseGalleryStyleId(rawId);
    if (!gid) continue;
    await dbQuery(
      `UPDATE barber_style_gallery SET sort_order = $2
       WHERE id = $1::uuid AND barber_id = $3`,
      [gid, order, barberKey],
    );
    order += 1;
  }
  return { updated: galleryIds.length };
}

module.exports = {
  GALLERY_ID_PREFIX,
  MAX_STYLE_GALLERY_PHOTOS_PER_BARBER,
  galleryStyleId,
  parseGalleryStyleId,
  mapGalleryRow,
  ensureBarberStyleGalleryTable,
  resolveBarberUuidByName,
  listGalleryImageUrlsForBarber,
  countGalleryForBarber,
  insertGalleryImage,
  listPublishedGalleryStyles,
  listAllGalleryStylesForAdmin,
  listGalleryStylesForBarber,
  resolveGalleryStyleRow,
  resolveGalleryStyleRowAdmin,
  updateGalleryMetadata,
  updateGalleryImageUrl,
  setGalleryPublished,
  deleteGalleryStyle,
  reorderGalleryStyles,
};
