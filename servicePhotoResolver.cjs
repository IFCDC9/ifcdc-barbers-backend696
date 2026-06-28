/**
 * Resolve booking/service card images from barber_services + barber_style_gallery.
 */
const { resolvePublishedImageUrl, FALLBACK_STYLE_IMAGE_URL, isRenderableImageUrl } = require("./styleImageUrl.cjs");
const { serviceNameKey } = require("./serviceImageEnrichment.cjs");

async function loadGalleryPhotoIndexForBarber(dbQuery, barberId) {
  const key = String(barberId || "").trim();
  const byServiceId = new Map();
  const byName = new Map();
  const all = [];
  if (!key) return { byServiceId, byName, all };

  try {
    const r = await dbQuery(
      `SELECT id, barber_id, service_id, title, image_url, sort_order,
              COALESCE(is_primary, false) AS is_primary, is_published
       FROM barber_style_gallery
       WHERE barber_id = $1 AND is_published = true
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC
       LIMIT 2000`,
      [key],
    );
    for (const row of r.rows || []) {
      const url = resolvePublishedImageUrl(row.image_url, {
        barberId: key,
        styleId: `gal-${row.id}`,
      });
      if (!url) continue;
      const entry = {
        id: `gal-${row.id}`,
        gallery_id: row.id,
        service_id: row.service_id,
        title: row.title,
        image_url: url,
        sort_order: Number(row.sort_order) || 0,
        is_primary: row.is_primary === true,
      };
      all.push(entry);

      if (row.service_id != null) {
        const sid = Number(row.service_id);
        if (!byServiceId.has(sid)) byServiceId.set(sid, []);
        byServiceId.get(sid).push(entry);
      }

      const nameKey = serviceNameKey(row.title);
      if (nameKey) {
        if (!byName.has(nameKey)) byName.set(nameKey, []);
        byName.get(nameKey).push(entry);
      }
    }
  } catch (e) {
    console.warn("[service-photo] gallery index:", e?.message || e);
  }

  return { byServiceId, byName, all };
}

function pickPrimaryFromGalleryList(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const primary = list.find((x) => x.is_primary);
  if (primary?.image_url) return primary.image_url;
  return list[0]?.image_url || "";
}

function resolveServiceCardImageUrl(serviceRow, galleryIndex) {
  const row = serviceRow || {};
  const serviceId = Number(row.id);
  const direct = resolvePublishedImageUrl(row.image_url, {
    serviceId: row.id,
    barberId: row.barber_id,
  });

  // barber_services.image_url is authoritative when set.
  if (direct && isRenderableImageUrl(direct)) return direct;

  // Only use gallery rows explicitly linked to this service id.
  if (galleryIndex && Number.isFinite(serviceId) && serviceId > 0) {
    const linked = galleryIndex.byServiceId.get(serviceId);
    const galleryUrl = pickPrimaryFromGalleryList(linked);
    if (galleryUrl && isRenderableImageUrl(galleryUrl)) return galleryUrl;
  }

  return "";
}

/**
 * Enrich service rows with primary gallery photo + gallery_photos array.
 */
function enrichServicesWithGalleryPhotos(services, galleryIndex, { includeGalleryList = false } = {}) {
  const list = Array.isArray(services) ? services : [];
  return list.map((svc) => {
    const image_url = resolveServiceCardImageUrl(svc, galleryIndex);
    const out = {
      ...svc,
      image_url: image_url || "",
      cover_image_url: image_url || FALLBACK_STYLE_IMAGE_URL,
    };
    if (includeGalleryList && galleryIndex) {
      const sid = Number(svc.id);
      const linked =
        Number.isFinite(sid) && sid > 0 ? galleryIndex.byServiceId.get(sid) || [] : [];
      out.gallery_photos = linked;
    }
    return out;
  });
}

module.exports = {
  loadGalleryPhotoIndexForBarber,
  resolveServiceCardImageUrl,
  enrichServicesWithGalleryPhotos,
  pickPrimaryFromGalleryList,
  FALLBACK_STYLE_IMAGE_URL,
  isRenderableImageUrl,
};
