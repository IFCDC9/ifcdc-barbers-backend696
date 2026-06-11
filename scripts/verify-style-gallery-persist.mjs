#!/usr/bin/env node
/**
 * Verify style gallery rows persist in Postgres after insert (local DATABASE_URL).
 * Usage: node --import ./loadBackendEnv.mjs scripts/verify-style-gallery-persist.mjs
 */
import { createRequire } from "node:module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { insertGalleryImage, deleteGalleryStyle } = require("../styleGalleryStore.cjs");

const barber = await dbQuery(`SELECT id::text AS id, name FROM barbers LIMIT 1`);
const barberId = barber.rows?.[0]?.id;
if (!barberId) {
  console.error("No barbers in database");
  process.exit(1);
}

const testUrl =
  "https://vtkxuagevtiwtoheomjt.supabase.co/storage/v1/object/public/barber-styles/ifcdc-barbers/1780886047802-sr6id2az.jpg";

const style = await insertGalleryImage(dbQuery, {
  barberId,
  title: `Persist verify ${Date.now()}`,
  price: 35,
  imageUrl: testUrl,
});

const reread = await dbQuery(
  `SELECT id, barber_id, title, image_url, is_published FROM barber_style_gallery WHERE id = $1::uuid`,
  [style.gallery_id || String(style.id).replace(/^gal-/, "")],
);

if (!reread.rows?.length) {
  console.error("FAIL: row missing after insert");
  process.exit(1);
}

await deleteGalleryStyle(dbQuery, style.id);
console.log("OK: gallery insert verified and cleaned up for barber", barber.rows[0].name);
