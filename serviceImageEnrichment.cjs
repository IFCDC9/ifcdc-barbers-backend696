/**
 * Resolve real service photos from barber_services and related style/CMS tables.
 */
const { resolvePublishedImageUrl } = require("./styleImageUrl.cjs");

function serviceNameKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @returns {Promise<{ stylesByName: Map<string,string>, photosByName: Map<string,string>, cmsByName: Map<string,string> }>}
 */
async function loadServiceImageSourcesForBarber(dbQuery, { barberKey, barberName }) {
  const stylesByName = new Map();
  const stylesByServiceId = new Map();
  const photosByName = new Map();
  const cmsByName = new Map();
  const keyText = String(barberKey ?? "").trim();
  const nameText = String(barberName || "").trim();

  if (keyText) {
    try {
      const gallery = await dbQuery(
        `SELECT service_id, title, image_url
         FROM barber_style_gallery
         WHERE barber_id = $1 AND is_published = true
         ORDER BY COALESCE(is_primary, false) DESC, sort_order ASC, created_at ASC`,
        [keyText],
      );
      for (const row of gallery.rows || []) {
        const url = resolvePublishedImageUrl(row.image_url, { barberId: keyText });
        if (!url) continue;
        const sid = Number(row.service_id);
        if (Number.isFinite(sid) && sid > 0 && !stylesByServiceId.has(sid)) {
          stylesByServiceId.set(sid, url);
        }
        const key = serviceNameKey(row.title);
        if (key && !stylesByName.has(key)) stylesByName.set(key, url);
      }
    } catch (e) {
      console.warn("[service-images] gallery lookup:", e?.message || e);
    }

    try {
      const styles = await dbQuery(
        `SELECT title, image_url, created_at
         FROM styles
         WHERE barber_id::text = $1::text AND COALESCE(is_published, true) = true
         ORDER BY created_at ASC`,
        [keyText],
      );
      for (const row of styles.rows || []) {
        const url = resolvePublishedImageUrl(row.image_url);
        const key = serviceNameKey(row.title);
        if (key && url && !stylesByName.has(key)) stylesByName.set(key, url);
      }
    } catch (e) {
      console.warn("[service-images] styles lookup:", e?.message || e);
    }
  }

  if (nameText) {
    try {
      const photos = await dbQuery(
        `SELECT style_name, image_url
         FROM barber_style_photos
         WHERE LOWER(barber_name) = LOWER($1)
         ORDER BY created_at ASC`,
        [nameText],
      );
      for (const row of photos.rows || []) {
        const url = resolvePublishedImageUrl(row.image_url);
        const key = serviceNameKey(row.style_name);
        if (key && url && !photosByName.has(key)) photosByName.set(key, url);
      }
    } catch (e) {
      console.warn("[service-images] barber_style_photos lookup:", e?.message || e);
    }

    try {
      const cms = await dbQuery(
        `SELECT s.name, i.url
         FROM barber_styles s
         INNER JOIN barber_profiles p ON p.id = s.barber_id
         INNER JOIN LATERAL (
           SELECT url FROM style_images
           WHERE style_id = s.id
           ORDER BY sort_order ASC, id ASC
           LIMIT 1
         ) i ON true
         WHERE LOWER(p.name) = LOWER($1)`,
        [nameText],
      );
      for (const row of cms.rows || []) {
        const url = resolvePublishedImageUrl(row.url);
        const key = serviceNameKey(row.name);
        if (key && url && !cmsByName.has(key)) cmsByName.set(key, url);
      }
    } catch (e) {
      console.warn("[service-images] cms style_images lookup:", e?.message || e);
    }
  }

  return { stylesByName, stylesByServiceId, photosByName, cmsByName };
}

/** Primary service image: barber_services.image_url, then gallery linked by service_id. */
function pickServiceImageUrl(row, sources) {
  const direct = resolvePublishedImageUrl(row?.image_url);
  if (direct) return direct;
  if (!sources) return "";

  const sid = Number(row?.id);
  if (Number.isFinite(sid) && sid > 0 && sources.stylesByServiceId?.has(sid)) {
    return sources.stylesByServiceId.get(sid);
  }

  const key = serviceNameKey(row?.name);
  if (!key) return "";

  return (
    sources.stylesByName.get(key) ||
    sources.photosByName.get(key) ||
    sources.cmsByName.get(key) ||
    ""
  );
}

module.exports = {
  serviceNameKey,
  loadServiceImageSourcesForBarber,
  pickServiceImageUrl,
};
