#!/usr/bin/env node
/**
 * Remove demo barbers (Fade Master, Clipper King) and Unsplash seed styles from Postgres.
 * Requires DATABASE_URL in environment (backend/.env or Render shell).
 *
 * Usage: node scripts/cleanup-demo-barbers.mjs
 * Dry run: IFCDC_DRY_RUN=1 node scripts/cleanup-demo-barbers.mjs
 */
import "../loadBackendEnv.mjs";
import { dbQuery } from "../db.js";

const DEMO_NAMES = ["fade master", "clipper king"];
const dryRun = String(process.env.IFCDC_DRY_RUN || "").trim() === "1";

async function count(sql, params = []) {
  const r = await dbQuery(sql, params);
  return Number(r.rows?.[0]?.n ?? 0);
}

console.log(dryRun ? "\n[DRY RUN] Demo cleanup\n" : "\nDemo barber cleanup\n");

const demoBarbers = await dbQuery(
  `SELECT id, name, profile_image FROM barbers
   WHERE lower(trim(name)) = ANY($1::text[])`,
  [DEMO_NAMES],
);
console.log("Demo barbers found:", demoBarbers.rows?.length ?? 0);
for (const row of demoBarbers.rows || []) {
  console.log(`  - id=${row.id} name=${row.name} image=${row.profile_image || ""}`);
}

const seedStyles = await count(
  `SELECT COUNT(*)::int AS n FROM styles WHERE image_url LIKE '%unsplash.com%'`,
);
console.log("Unsplash seed styles:", seedStyles);

if (dryRun) {
  console.log("\nRe-run without IFCDC_DRY_RUN=1 to delete.\n");
  process.exit(0);
}

if ((demoBarbers.rows?.length ?? 0) === 0 && seedStyles === 0) {
  console.log("\nNothing to clean up.\n");
  process.exit(0);
}

for (const row of demoBarbers.rows || []) {
  const id = row.id;
  await dbQuery(`DELETE FROM styles WHERE barber_id::text = $1::text`, [String(id)]);
  await dbQuery(`DELETE FROM barber_styles WHERE barber_id::text = $1::text`, [String(id)]).catch(() => {});
  await dbQuery(`DELETE FROM barber_services WHERE barber_id::text = $1::text`, [String(id)]);
  await dbQuery(`DELETE FROM barber_settings WHERE barber_id::text = $1::text`, [String(id)]).catch(() => {});
  await dbQuery(`DELETE FROM barbers WHERE id::text = $1::text`, [String(id)]);
  console.log(`Deleted barber id=${id} (${row.name})`);
}

const delStyles = await dbQuery(`DELETE FROM styles WHERE image_url LIKE '%unsplash.com%' RETURNING id`);
console.log(`Deleted ${delStyles.rowCount ?? 0} Unsplash seed style(s)`);

await dbQuery(
  `DELETE FROM barber_profiles WHERE lower(trim(name)) = ANY($1::text[])`,
  [DEMO_NAMES],
).catch(() => {});

console.log("\nDemo cleanup complete.\n");
process.exit(0);
