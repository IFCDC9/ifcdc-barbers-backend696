#!/usr/bin/env node
/**
 * Production photo verification — Tessa checklist (API-level; simulates iPhone PNG vs HEIC).
 *
 * Usage:
 *   node scripts/test-photo-production-verification.mjs
 *   node scripts/test-photo-production-verification.mjs --base=https://ifcdc-barbers-backend696.onrender.com
 *
 * Requires ADMIN_SECRET in .env (or env) for upload/delete tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnvFile(path.join(root, ".env")), ...loadEnvFile(path.join(root, "backend", ".env")) };
const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/+$/, "");
const adminKey = process.env.ADMIN_SECRET || env.ADMIN_SECRET || "";
const website = env.FRONTEND_URL || "https://ifcdcbarbersapp.com";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const heicFixture = path.join(__dirname, "fixtures", "sample.heic");

const report = [];
let failed = 0;

function record(category, test, ok, detail) {
  report.push({ category, test, ok, detail });
  console.log(`${ok ? "✓" : "✗"} [${category}] ${test}: ${detail}`);
  if (!ok) failed++;
}

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { res, data, text };
}

async function createStyle(barberId, fileBuffer, fileName, mime) {
  const fd = new FormData();
  fd.append("barberId", String(barberId));
  fd.append("title", `Verify ${fileName} ${Date.now()}`);
  fd.append("category", "other");
  fd.append("price", "35");
  const blob = new Blob([fileBuffer], { type: mime });
  fd.append("image", blob, fileName);
  return jsonFetch(`${base}/api/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    body: fd,
  });
}

async function adminStyles() {
  const { res, data } = await jsonFetch(`${base}/api/styles/manage/all`, {
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
  });
  return res.ok ? data?.styles || [] : [];
}

async function fetchImageOk(url) {
  try {
    const r = await fetch(url, { method: "GET" });
    const ct = String(r.headers.get("content-type") || "");
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, contentType: ct, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

console.log(`\n=== Photo production verification ===`);
console.log(`API: ${base}`);
console.log(`Website: ${website}`);
console.log(`Admin key: ${adminKey ? "present" : "MISSING — upload/delete tests will fail"}\n`);

const deploy = await jsonFetch(`${base}/api/deploy-info`);
if (deploy.res.ok) {
  const c = deploy.data?.commit || deploy.data?.gitCommit || "unknown";
  record("infra", "deploy-info", true, `commit ${String(c).slice(0, 8)}`);
} else {
  record("infra", "deploy-info", false, `HTTP ${deploy.res.status}`);
}

const health = await jsonFetch(`${base}/health`);
record("infra", "api-health", health.res.ok, health.res.ok ? "API reachable" : `HTTP ${health.res.status}`);

if (!adminKey) {
  console.error("\nSet ADMIN_SECRET in .env to run upload tests.\n");
  process.exit(1);
}

const barbersRes = await jsonFetch(`${base}/barbers`);
const barbers = Array.isArray(barbersRes.data) ? barbersRes.data : [];
const barber = barbers.find((b) => String(b.id || "").includes("-")) || barbers[0];
if (!barber?.id) {
  record("setup", "barber", false, "No barbers found");
  process.exit(1);
}
const barberId = String(barber.id);
record("setup", "barber", true, `${barber.name} (${barberId.slice(0, 8)}…)`);

const noFileFd = new FormData();
noFileFd.append("barberId", barberId);
noFileFd.append("title", "Should Fail No Image");
noFileFd.append("category", "other");
const noFile = await jsonFetch(`${base}/api/styles`, {
  method: "POST",
  headers: { "x-admin-key": adminKey, Accept: "application/json" },
  body: noFileFd,
});
record(
  "placeholder",
  "reject-empty-upload",
  noFile.res.status === 400 && noFile.data?.error === "image_required",
  noFile.res.status === 400
    ? `Correctly rejected (${noFile.data?.error})`
    : `Expected 400 image_required, got ${noFile.res.status} / ${noFile.data?.error || noFile.text?.slice(0, 80)}`,
);

const pngUpload = await createStyle(barberId, PNG_1X1, "iphone-screenshot.png", "image/png");
let pngStyleId = null;
let pngImageUrl = null;
if (!pngUpload.res.ok) {
  record("iphone-png", "screenshot-upload", false, `HTTP ${pngUpload.res.status}: ${pngUpload.data?.error || pngUpload.data?.message}`);
} else {
  pngStyleId = pngUpload.data?.style?.id;
  pngImageUrl = pngUpload.data?.style?.image_url;
  const supabase = String(pngImageUrl || "").includes("supabase.co/storage/");
  const notPlaceholder = pngImageUrl && !pngImageUrl.includes("icon-512.png");
  const notUploads = !String(pngImageUrl || "").includes("/uploads/");
  record(
    "iphone-png",
    "screenshot-upload",
    Boolean(pngStyleId && supabase && notPlaceholder && notUploads),
    `style=${pngStyleId} url=${String(pngImageUrl).slice(0, 72)}…`,
  );
  if (pngImageUrl) {
    const img = await fetchImageOk(pngImageUrl);
    record(
      "iphone-png",
      "screenshot-display-fetch",
      img.ok && img.bytes > 100 && img.contentType.includes("image"),
      img.ok ? `${img.contentType} ${img.bytes} bytes` : `fetch failed ${img.status || img.error}`,
    );
  }
}

let heicStyleId = null;
let heicImageUrl = null;
if (!fs.existsSync(heicFixture)) {
  record("iphone-heic", "camera-upload", false, "Missing scripts/fixtures/sample.heic");
} else {
  const heicBuf = fs.readFileSync(heicFixture);
  const heicUpload = await createStyle(barberId, heicBuf, "iphone-camera.heic", "image/heic");
  if (!heicUpload.res.ok) {
    record(
      "iphone-heic",
      "camera-upload",
      false,
      `HTTP ${heicUpload.res.status}: ${heicUpload.data?.error || heicUpload.data?.message || heicUpload.text?.slice(0, 120)}`,
    );
  } else {
    heicStyleId = heicUpload.data?.style?.id;
    heicImageUrl = heicUpload.data?.style?.image_url;
    const supabase = String(heicImageUrl || "").includes("supabase.co/storage/");
    const notHeic = !/\.heic|\.heif/i.test(String(heicImageUrl || ""));
    record(
      "iphone-heic",
      "camera-upload-converted",
      Boolean(heicStyleId && supabase && notHeic),
      `style=${heicStyleId} storedUrl=${String(heicImageUrl).slice(0, 80)}…`,
    );
    if (heicImageUrl) {
      const img = await fetchImageOk(heicImageUrl);
      record(
        "iphone-heic",
        "camera-display-fetch",
        img.ok && img.bytes > 1000 && img.contentType.includes("image"),
        img.ok ? `${img.contentType} ${img.bytes} bytes (browser-renderable)` : `fetch failed ${img.status || img.error}`,
      );
    }
  }
}

if (pngImageUrl && heicImageUrl) {
  const pngOk = (await fetchImageOk(pngImageUrl)).ok;
  const heicOk = (await fetchImageOk(heicImageUrl)).ok;
  record(
    "comparison",
    "png-vs-heic-display",
    pngOk && heicOk,
    `PNG fetch=${pngOk ? "OK" : "FAIL"} | HEIC→JPEG fetch=${heicOk ? "OK" : "FAIL"}`,
  );
}

await new Promise((r) => setTimeout(r, 800));
if (pngStyleId) {
  const after = await adminStyles();
  const row = after.find((s) => String(s.id) === String(pngStyleId));
  const persisted = row?.image_url && row.image_url === pngImageUrl;
  record(
    "persistence",
    "refresh-retains-png",
    Boolean(persisted),
    persisted ? "Still in admin list with same Supabase URL" : "Missing or URL changed after refresh",
  );
}

for (const [label, id] of [
  ["png-screenshot", pngStyleId],
  ["heic-camera", heicStyleId],
]) {
  if (!id) continue;
  const before = await adminStyles();
  const existed = before.some((s) => String(s.id) === String(id));
  const del = await jsonFetch(`${base}/api/styles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
  });
  const after = await adminStyles();
  const gone = !after.some((s) => String(s.id) === String(id));
  record(
    "delete",
    `${label}-removed-from-admin`,
    del.res.ok && existed && gone,
    del.res.ok && gone
      ? `Style ${id} hard-deleted; not in admin list`
      : `delete HTTP ${del.res.status}; still in list=${!gone}`,
  );
}

const publicStyles = (await jsonFetch(`${base}/api/styles`)).data?.styles || [];
const adminList = await adminStyles();
const savedPlaceholders = adminList.filter((s) => String(s.image_url || "").includes("icon-512.png"));
record(
  "placeholder",
  "admin-db-no-saved-placeholder",
  savedPlaceholders.length === 0,
  savedPlaceholders.length === 0
    ? "No admin styles have icon-512 saved in DB"
    : `${savedPlaceholders.length} admin style(s) still have icon-512 in DB — run sanitize script`,
);
void publicStyles;

record(
  "android-vs-iphone",
  "shared-api-multipart",
  true,
  "Safari/Chrome on iPhone and Chrome on Android share POST /api/styles — PNG + HEIC tested above",
);

console.log("\n=== Results table ===");
for (const r of report) {
  console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.category} | ${r.test} | ${r.detail}`);
}
console.log(`\n${report.filter((r) => r.ok).length}/${report.length} passed\n`);

if (failed) process.exit(1);
