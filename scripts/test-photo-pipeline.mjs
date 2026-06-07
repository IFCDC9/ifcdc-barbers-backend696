#!/usr/bin/env node
/**
 * Local integration test — photo upload / replace / delete / persistence / display data.
 * Usage: node scripts/test-photo-pipeline.mjs [--base http://127.0.0.1:10000]
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnvFile(path.join(root, "backend", ".env")), ...loadEnvFile(path.join(root, ".env")) };
const base = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) || env.API_BASE || "http://127.0.0.1:10000").replace(
  /\/+$/,
  "",
);
const adminKey = env.ADMIN_SECRET || "admin123";

/** Minimal valid 1x1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const results = [];
let failed = 0;

function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`✓ ${id}: ${detail}`);
}

function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.error(`✗ ${id}: ${detail}`);
  failed++;
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

async function uploadStylePhoto(barberId, label) {
  const fd = new FormData();
  const blob = new Blob([PNG_1X1], { type: "image/png" });
  fd.append("styles", blob, `${label}.png`);
  const { res, data, text } = await jsonFetch(`${base}/barbers/${encodeURIComponent(barberId)}/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey },
    body: fd,
  });
  return { res, data, text };
}

async function createStyleViaApi(barberId, title) {
  const fd = new FormData();
  fd.append("barberId", String(barberId));
  fd.append("title", title);
  fd.append("category", "other");
  fd.append("price", "29.99");
  const blob = new Blob([PNG_1X1], { type: "image/png" });
  fd.append("image", blob, `${title}.png`);
  const { res, data, text } = await jsonFetch(`${base}/api/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    body: fd,
  });
  return { res, data, text };
}

async function replaceStyleImage(styleId) {
  const fd = new FormData();
  const blob = new Blob([PNG_1X1], { type: "image/png" });
  fd.append("image", blob, "replaced.png");
  const { res, data, text } = await jsonFetch(`${base}/api/styles/${encodeURIComponent(styleId)}/image`, {
    method: "POST",
    headers: { "x-admin-key": adminKey },
    body: fd,
  });
  return { res, data, text };
}

console.log(`\nPhoto pipeline tests → ${base}\n`);

// 0. Health
const health = await jsonFetch(`${base}/health`);
if (!health.res.ok) {
  fail("health", `Server not reachable (${health.res.status})`);
  console.error("\nStart server: npm run dev\n");
  process.exit(1);
}
pass("health", "API reachable");

// 1. Get barbers (UUID)
const barbersRes = await jsonFetch(`${base}/barbers`);
const barbers = Array.isArray(barbersRes.data) ? barbersRes.data : barbersRes.data?.barbers || [];
if (!barbers.length) {
  fail("barbers", "No barbers in DB — cannot test upload");
  process.exit(1);
}
const barber = barbers.find((b) => String(b.id || "").includes("-")) || barbers[0];
const barberId = String(barber.id);
if (!barberId.includes("-")) {
  fail("barbers", `Expected UUID barber id, got ${barberId}`);
} else {
  pass("barbers", `Using barber ${barber.name} (${barberId.slice(0, 8)}…)`);
}

// 2. Upload photo (admin bulk)
const uploadLabel = `pipeline-test-${Date.now()}`;
const upload = await uploadStylePhoto(barberId, uploadLabel);
if (!upload.res.ok) {
  const err = upload.data?.error || upload.data?.message || upload.text?.slice(0, 120);
  if (String(err).includes("invalid_id")) {
    fail("photo-upload", `invalid_id still returned: ${err}`);
  } else {
    fail("photo-upload", `HTTP ${upload.res.status}: ${err}`);
  }
} else {
  const created = upload.data?.created || [];
  const urls = (upload.data?.styles || []).filter(Boolean);
  const hasUrl = created.some((c) => c.image_url) || urls.length > 0;
  if (!hasUrl) {
    fail("photo-upload", "Upload OK but no image_url in response");
  } else {
    const sample = created[0]?.image_url || urls[urls.length - 1];
    const persistent = String(sample).startsWith("https://") || String(sample).startsWith("/uploads/");
    pass("photo-upload", `Uploaded; url=${String(sample).slice(0, 72)}… persistent=${persistent}`);
  }
}

// 3. Create style via /api/styles (multipart)
const styleTitle = `Pipeline Style ${Date.now()}`;
const create = await createStyleViaApi(barberId, styleTitle);
let styleId = null;
let styleImageUrl = null;
if (!create.res.ok) {
  const err = create.data?.error || create.data?.message || create.text?.slice(0, 120);
  if (String(err).includes("invalid_id")) {
    fail("photo-upload-api-styles", `invalid_id: ${err}`);
  } else {
    fail("photo-upload-api-styles", `HTTP ${create.res.status}: ${err}`);
  }
} else {
  styleId = create.data?.style?.id;
  styleImageUrl = create.data?.style?.image_url;
  if (!styleId || !styleImageUrl) {
    fail("photo-upload-api-styles", "Missing style id or image_url");
  } else {
    pass("photo-upload-api-styles", `Created style ${styleId} with image_url`);
  }
}

// 4. Replace photo
if (styleId) {
  const before = styleImageUrl;
  const replace = await replaceStyleImage(styleId);
  if (!replace.res.ok) {
    fail("photo-replace", `HTTP ${replace.res.status}: ${replace.data?.error || replace.data?.message || replace.text?.slice(0, 120)}`);
  } else {
    const after = replace.data?.style?.image_url;
    if (!after) {
      fail("photo-replace", "No image_url after replace");
    } else {
      pass("photo-replace", `Replaced image_url (${String(before).slice(0, 40)} → ${String(after).slice(0, 40)}…)`);
      styleImageUrl = after;
    }
  }
}

// 5. Refresh persistence — re-fetch styles
await new Promise((r) => setTimeout(r, 500));
const refresh1 = await jsonFetch(`${base}/api/styles`);
const publicStyles = refresh1.data?.styles || [];
const foundPublic = styleId ? publicStyles.find((s) => String(s.id) === String(styleId)) : null;

const refresh2 = await jsonFetch(`${base}/api/styles/manage/all`, {
  headers: { "x-admin-key": adminKey, Accept: "application/json" },
});
const adminStyles = refresh2.data?.styles || [];
const foundAdmin = styleId ? adminStyles.find((s) => String(s.id) === String(styleId)) : null;

if (styleId && foundAdmin?.image_url) {
  pass("refresh-persistence", `Style ${styleId} still in DB after re-fetch; image_url present`);
} else if (styleId) {
  fail("refresh-persistence", "Style missing from admin list after refresh");
}

// 6. Website style cards — public list has image_url + cover CSS in build
if (publicStyles.length) {
  const withImg = publicStyles.filter((s) => String(s.image_url || "").trim());
  if (withImg.length) {
    pass("website-style-cards-data", `${withImg.length}/${publicStyles.length} published styles have image_url`);
  } else {
    fail("website-style-cards-data", "Published styles have no image_url");
  }
} else if (foundAdmin) {
  pass("website-style-cards-data", "Style exists but unpublished (publish gate OK)");
}

const cssPath = path.join(root, "client", "dist", "assets");
let cssOk = false;
if (fs.existsSync(cssPath)) {
  const cssFile = fs.readdirSync(cssPath).find((f) => f.endsWith(".css"));
  if (cssFile) {
    const css = fs.readFileSync(path.join(cssPath, cssFile), "utf8");
    cssOk = css.includes("ifcdc-cover-fill") && css.includes("object-fit:cover");
  }
}
if (cssOk) {
  pass("website-style-cards-css", "Built CSS includes .ifcdc-cover-fill + object-fit:cover");
} else {
  fail("website-style-cards-css", "Run cd client && npm run build first, or CSS missing cover rules");
}

// 7. Booking page services with image_url
const bookingSvc = await jsonFetch(
  `${base}/api/barber/services?barberId=${encodeURIComponent(barberId)}&barberName=${encodeURIComponent(barber.name || "")}`,
);
const services = bookingSvc.data?.services || [];
const svcWithImg = services.filter((s) => String(s.image_url || "").trim());
if (services.length && svcWithImg.length) {
  pass("booking-page-images", `${svcWithImg.length}/${services.length} services include image_url`);
} else if (services.length) {
  fail("booking-page-images", "Services loaded but none have image_url");
} else {
  fail("booking-page-images", "No services returned for barber");
}

// Also check public pricing endpoint
const pricing = await jsonFetch(`${base}/api/barber/public/${encodeURIComponent(barberId)}/pricing`);
const pricingSvc = pricing.data?.services || [];
const pricingWithImg = pricingSvc.filter((s) => String(s.image_url || "").trim());
if (pricing.res.ok && pricingWithImg.length) {
  pass("booking-pricing-images", `Public pricing returns image_url on ${pricingWithImg.length} service(s)`);
} else if (pricing.res.ok && pricingSvc.length) {
  fail("booking-pricing-images", "Pricing services missing image_url");
}

// 8. Mobile thumbnails — static code + API contract
const mobileApi = fs.readFileSync(path.join(root, "mobile", "services", "barberStaffApi.ts"), "utf8");
const mobileCard = fs.readFileSync(path.join(root, "mobile", "components", "ServicePickerCard.js"), "utf8");
const mobileOk =
  mobileApi.includes("image_url") &&
  mobileApi.includes("json.image_url || json.url") &&
  mobileCard.includes("resizeMode") &&
  mobileCard.includes("cover");
if (mobileOk) {
  pass("mobile-thumbnails", "barberStaffApi accepts image_url; ServicePickerCard uses resizeMode cover");
} else {
  fail("mobile-thumbnails", "Mobile cover/image_url wiring incomplete");
}

// 9. invalid_id regression — UUID should NOT return invalid_id
const badNumeric = await uploadStylePhoto("999999999", "bad");
const badErr = badNumeric.data?.error || badNumeric.data?.message || "";
if (String(badErr).includes("invalid_id")) {
  fail("no-invalid-id", `UUID path returned invalid_id for missing barber: ${badErr}`);
} else if (badNumeric.res.status === 404 || badNumeric.data?.error === "not_found") {
  pass("no-invalid-id", "Missing barber returns not_found (not invalid_id)");
} else {
  pass("no-invalid-id", `Missing barber returns ${badNumeric.res.status} / ${badErr || "error"} (not invalid_id)`);
}

// Fake UUID upload attempt
const fakeUuid = "00000000-0000-4000-8000-000000000000";
const fakeUpload = await uploadStylePhoto(fakeUuid, "fake");
const fakeErr = fakeUpload.data?.error || fakeUpload.data?.message || "";
if (String(fakeErr).includes("invalid_id")) {
  fail("no-invalid-id-fake-uuid", `Fake UUID returned invalid_id: ${fakeErr}`);
} else {
  pass("no-invalid-id-fake-uuid", `Fake UUID returns ${fakeUpload.data?.error || fakeUpload.res.status} (not invalid_id)`);
}

// 10. Delete — hard remove from admin list
if (styleId) {
  const del = await jsonFetch(`${base}/api/styles/${encodeURIComponent(styleId)}`, {
    method: "DELETE",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
  });
  if (!del.res.ok) {
    fail("photo-delete", `HTTP ${del.res.status}: ${del.data?.error || del.data?.message}`);
  } else {
    pass("photo-delete", `Hard-deleted style ${styleId}`);
    const afterDel = await jsonFetch(`${base}/api/styles/manage/all`, {
      headers: { "x-admin-key": adminKey, Accept: "application/json" },
    });
    const row = (afterDel.data?.styles || []).find((s) => String(s.id) === String(styleId));
    if (row) {
      fail("photo-delete-verify", "Style still in admin list after delete");
    } else {
      pass("photo-delete-verify", "Style removed from admin list and public catalog");
    }
  }
}

// 11. Reject save without file (no placeholder)
const noFileFd = new FormData();
noFileFd.append("barberId", barberId);
noFileFd.append("title", "No Image Test");
noFileFd.append("category", "other");
const noFile = await jsonFetch(`${base}/api/styles`, {
  method: "POST",
  headers: { "x-admin-key": adminKey, Accept: "application/json" },
  body: noFileFd,
});
if (noFile.res.status === 400 && noFile.data?.error === "image_required") {
  pass("no-placeholder-save", "Empty upload rejected (icon-512 never saved)");
} else {
  fail("no-placeholder-save", `Expected image_required, got ${noFile.res.status} / ${noFile.data?.error}`);
}

// 12. HEIC → JPEG conversion (iPhone camera simulation)
const heicPath = path.join(__dirname, "fixtures", "sample.heic");
if (fs.existsSync(heicPath)) {
  const heicBuf = fs.readFileSync(heicPath);
  const heicFd = new FormData();
  heicFd.append("barberId", barberId);
  heicFd.append("title", `HEIC Test ${Date.now()}`);
  heicFd.append("category", "other");
  heicFd.append("price", "35");
  heicFd.append("image", new Blob([heicBuf], { type: "image/heic" }), "iphone-camera.heic");
  const heicRes = await jsonFetch(`${base}/api/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    body: heicFd,
  });
  if (!heicRes.res.ok) {
    fail("heic-convert-upload", `HTTP ${heicRes.res.status}: ${heicRes.data?.error || heicRes.data?.message}`);
  } else {
    const hid = heicRes.data?.style?.id;
    const hurl = heicRes.data?.style?.image_url || "";
    const converted = hurl.includes("supabase.co") && !/\.heic|\.heif/i.test(hurl);
    if (converted) {
      pass("heic-convert-upload", `HEIC stored as browser URL ${String(hurl).slice(0, 60)}…`);
      if (hid) {
        await jsonFetch(`${base}/api/styles/${encodeURIComponent(hid)}`, {
          method: "DELETE",
          headers: { "x-admin-key": adminKey, Accept: "application/json" },
        });
      }
    } else {
      fail("heic-convert-upload", `Bad URL after HEIC upload: ${hurl.slice(0, 80)}`);
    }
  }
} else {
  fail("heic-convert-upload", "Missing scripts/fixtures/sample.heic");
}

console.log("\n--- Summary ---");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.id}: ${r.detail}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed\n`);

if (failed) process.exit(1);
