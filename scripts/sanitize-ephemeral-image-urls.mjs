#!/usr/bin/env node
/**
 * Clear ephemeral /uploads image_url values in barber_services (run once on production DB).
 * Usage: node --import ./loadBackendEnv.mjs scripts/sanitize-ephemeral-image-urls.mjs [--dry-run]
 */
import { dbQuery } from "../db.js";
import { isEphemeralUploadUrl } from "../styleImageUrl.cjs";

const dryRun = process.argv.includes("--dry-run");

const r = await dbQuery(
  `SELECT id, barber_id, name, image_url FROM barber_services
   WHERE COALESCE(image_url, '') <> ''`,
);
const rows = r.rows || [];
const bad = rows.filter((row) => isEphemeralUploadUrl(row.image_url));

console.log(`Found ${bad.length} barber_services row(s) with ephemeral image_url (of ${rows.length} total).`);

for (const row of bad) {
  console.log(`  id=${row.id} barber=${row.barber_id} name=${row.name}`);
  console.log(`    was: ${row.image_url}`);
  if (!dryRun) {
    await dbQuery(`DELETE FROM barber_services WHERE id = $1`, [row.id]);
    console.log("    deleted row (ephemeral/broken URL — re-upload via Admin)");
  }
}

if (dryRun) {
  console.log("\nDry run — no rows updated. Re-run without --dry-run to apply.");
} else {
  console.log("\nDone. Re-upload photos via Admin or Shop dashboard for affected services.");
}

const barbers = await dbQuery(
  `SELECT id, name, profile_image FROM barbers WHERE COALESCE(profile_image, '') <> ''`,
);
const badBarbers = (barbers.rows || []).filter((row) => isEphemeralUploadUrl(row.profile_image));
console.log(`\nFound ${badBarbers.length} barber(s) with ephemeral profile_image (of ${(barbers.rows || []).length} total).`);
for (const row of badBarbers) {
  console.log(`  id=${row.id} name=${row.name}`);
  console.log(`    was: ${row.profile_image}`);
  if (!dryRun) {
    await dbQuery(`UPDATE barbers SET profile_image = NULL WHERE id = $1`, [row.id]);
    console.log("    now: NULL (re-upload via Admin)");
  }
}

const placeholderServices = await dbQuery(
  `SELECT id, barber_id, name, image_url FROM barber_services
   WHERE COALESCE(image_url, '') ILIKE '%icon-512.png%'`,
);
const phRows = placeholderServices.rows || [];
console.log(`\nFound ${phRows.length} barber_services row(s) with placeholder icon-512 saved as image_url.`);
for (const row of phRows) {
  console.log(`  id=${row.id} barber=${row.barber_id} name=${row.name}`);
  if (!dryRun) {
    await dbQuery(`DELETE FROM barber_services WHERE id = $1`, [row.id]);
    console.log("    deleted row (was placeholder, not a real upload)");
  }
}
