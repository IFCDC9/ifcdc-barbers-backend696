/**
 * Normalize Discover / gallery / service / review photo categories to canonical ids.
 * Does not delete content.
 */
import { dbQuery } from "../db.js";
import { normalizeDiscoverCategory } from "../discoverCategories.js";

async function repairTable(label, sqlSelect, sqlUpdate) {
  const r = await dbQuery(sqlSelect);
  let changed = 0;
  for (const row of r.rows || []) {
    const next = normalizeDiscoverCategory(row.category);
    if (String(row.category || "").trim().toLowerCase() === next) continue;
    await dbQuery(sqlUpdate, [next, row.id]);
    changed += 1;
  }
  console.log(`[discover-repair] ${label}: scanned=${r.rows?.length || 0} updated=${changed}`);
  return changed;
}

const galleryUpdated = await repairTable(
  "barber_style_gallery",
  `SELECT id, category FROM barber_style_gallery WHERE category IS NOT NULL AND trim(category) <> ''`,
  `UPDATE barber_style_gallery SET category = $1 WHERE id = $2::uuid`,
);

const servicesUpdated = await repairTable(
  "barber_services",
  `SELECT id, category FROM barber_services WHERE category IS NOT NULL AND trim(category) <> ''`,
  `UPDATE barber_services SET category = $1 WHERE id::text = $2::text`,
);

const reviewsUpdated = await repairTable(
  "review_photos",
  `SELECT id, style_category AS category FROM review_photos WHERE style_category IS NOT NULL AND trim(style_category) <> ''`,
  `UPDATE review_photos SET style_category = $1 WHERE id = $2::uuid`,
);

// Hide soft-broken empty gallery URLs from Discover by unpublishing
const broken = await dbQuery(
  `UPDATE barber_style_gallery
   SET is_published = false
   WHERE COALESCE(is_published, true) = true
     AND (image_url IS NULL OR trim(image_url) = '')
   RETURNING id`,
);
console.log(`[discover-repair] unpublished empty gallery rows=${broken.rows?.length || 0}`);

console.log(
  JSON.stringify({
    ok: true,
    galleryUpdated,
    servicesUpdated,
    reviewsUpdated,
    unpublishedEmpty: broken.rows?.length || 0,
  }),
);
process.exit(0);
