#!/usr/bin/env node
/**
 * Migrate legacy /uploads/ and local disk image URLs to Supabase storage.
 * Usage: node scripts/migrate-legacy-uploads-to-supabase.mjs [--dry-run] [--base URL]
 */
import "../loadBackendEnv.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbQuery } from "../db.js";
import { uploadBarberStyleImage } from "../src/services/storageUpload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const apiBase = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/+$/, "");

const migrated = new Map();

function isLegacyUrl(url) {
  const u = String(url || "").trim();
  if (!u) return false;
  if (u.includes("supabase.co/storage/")) return false;
  return u.includes("/uploads/") || u.startsWith("/uploads/");
}

async function loadBufferForUrl(url) {
  const u = String(url || "").trim();
  if (!u) return null;

  if (migrated.has(u)) return migrated.get(u);

  let fetchUrl = u;
  if (u.startsWith("/")) fetchUrl = `${apiBase}${u}`;

  if (fetchUrl.startsWith("http")) {
    try {
      const res = await fetch(fetchUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { buffer: buf, mimetype: res.headers.get("content-type") || "image/jpeg", originalName: path.basename(u) };
    } catch {
      return null;
    }
  }

  const localPath = path.join(root, "backend", u.replace(/^\//, ""));
  const altPath = path.join(root, u.replace(/^\//, ""));
  for (const p of [localPath, altPath]) {
    if (fs.existsSync(p)) {
      return { buffer: fs.readFileSync(p), mimetype: "image/jpeg", originalName: path.basename(p) };
    }
  }
  return null;
}

async function migrateUrl(url, barberName = "migration") {
  const u = String(url || "").trim();
  if (!u || !isLegacyUrl(u)) return u;
  if (migrated.has(u)) return migrated.get(u);

  const payload = await loadBufferForUrl(u);
  if (!payload?.buffer?.length) {
    console.warn(`SKIP (unreadable): ${u}`);
    return u;
  }

  if (dryRun) {
    console.log(`DRY RUN would migrate: ${u}`);
    return u;
  }

  const { url: newUrl } = await uploadBarberStyleImage({
    buffer: payload.buffer,
    mimetype: payload.mimetype,
    barberName,
    originalName: payload.originalName,
  });
  migrated.set(u, newUrl);
  console.log(`OK  ${u} → ${newUrl}`);
  return newUrl;
}

async function updateColumn(table, column, idColumn = "id") {
  const r = await dbQuery(`SELECT ${idColumn} AS id, ${column} AS url FROM ${table} WHERE ${column} LIKE '%/uploads/%'`);
  let n = 0;
  for (const row of r.rows || []) {
    const next = await migrateUrl(row.url, table);
    if (next && next !== row.url) {
      await dbQuery(`UPDATE ${table} SET ${column} = $2 WHERE ${idColumn} = $1`, [row.id, next]);
      n++;
    }
  }
  return n;
}

console.log(`\nLegacy upload migration → ${apiBase}${dryRun ? " (dry run)" : ""}\n`);

let total = 0;
total += await updateColumn("barbers", "profile_image");
total += await updateColumn("barbers", "logo");
total += await updateColumn("barber_services", "image_url");
total += await updateColumn("barber_style_gallery", "image_url");
total += await updateColumn("review_photos", "photo_url");
total += await updateColumn("review_photos", "thumbnail_url");
total += await updateColumn("barber_portfolio_images", "image_url");

const styles = await dbQuery(`SELECT id, image_url FROM styles WHERE image_url LIKE '%/uploads/%'`);
for (const row of styles.rows || []) {
  const next = await migrateUrl(row.image_url, "styles");
  if (next && next !== row.image_url) {
    await dbQuery(`UPDATE styles SET image_url = $2 WHERE id = $1`, [row.id, next]);
    total++;
  }
}

console.log(`\nDone. ${total} row(s) updated, ${migrated.size} unique file(s) migrated.\n`);
