#!/usr/bin/env node
/**
 * V2 quality pass — portfolio, reviews, moderation, booking regression gates.
 * Usage: node scripts/verify-v2-quality.mjs [--base URL]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

async function get(path, init) {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { res, json, url };
}

let failed = 0;
function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK  ${msg}`);
}

console.log(`\nV2 quality verification → ${base}\n`);

const deploy = await get("/api/deploy-info");
if (!deploy.res.ok) fail("deploy-info");
else ok(`deploy ${deploy.json.activeCommitShort || "unknown"}`);

const health = await get("/api/health");
if (!health.res.ok && health.res.status !== 200) fail("health");
else ok("API health");

const barbers = await get("/api/app-bookings/barbers");
if (!barbers.res.ok || !Array.isArray(barbers.json)) fail("booking barbers");
else ok(`booking barbers (${barbers.json.length})`);

const cats = await get("/api/portfolio/meta/categories");
if (!cats.res.ok || !cats.json.ok || !Array.isArray(cats.json.categories)) fail("portfolio meta");
else {
  ok(`portfolio categories (${cats.json.categories.length})`);
  if (!Array.isArray(cats.json.reportReasons) || !cats.json.reportReasons.length) {
    fail("report reasons missing from portfolio meta");
  } else ok("report reasons exposed");
}

const discover = await get("/api/portfolio/discover?limit=3");
if (!discover.res.ok || !discover.json.ok) fail("discover feed");
else ok(`discover feed (${(discover.json.photos || []).length} photos)`);

const firstBarber = Array.isArray(barbers.json) && barbers.json[0];
if (firstBarber?.id) {
  const portfolio = await get(`/api/portfolio/${encodeURIComponent(firstBarber.id)}`);
  if (!portfolio.res.ok || !portfolio.json.ok) fail("public portfolio");
  else {
    const p = portfolio.json.portfolio;
    ok(`portfolio ${p.name} rating=${p.averageRating} reviews=${p.reviewCount}`);
    if (typeof p.averageRating !== "number") fail("averageRating not numeric");
    if (!Array.isArray(p.gallery)) fail("gallery missing");
    else if (p.gallery.length) {
      const thumb = p.gallery[0];
      if (!thumb.thumbnailUrl) fail("gallery photo missing thumbnailUrl");
      else ok("gallery thumbnails present");
    }
  }
}

const reviewStatus = await get("/api/bookings/00000000-0000-0000-0000-000000000001/review-status");
if (reviewStatus.res.status !== 401) fail("review-status should require auth");
else ok("review-status requires auth");

const patchNoAuth = await fetch(`${base.replace(/\/+$/, "")}/api/reviews/00000000-0000-0000-0000-000000000001`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ rating: 5 }),
});
if (patchNoAuth.status !== 401) fail(`PATCH /api/reviews should require auth (got ${patchNoAuth.status})`);
else ok("review edit endpoint secured");

const reportNoAuth = await get("/api/content/report", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ targetType: "review", targetId: "1", reason: "spam" }),
});
if (reportNoAuth.res.status !== 401) fail("content report should require auth");
else ok("content report secured");

const adminReports = await get("/api/admin/content/reports");
if (adminReports.res.status !== 401 && adminReports.res.status !== 403) {
  fail(`admin reports should require admin (got ${adminReports.res.status})`);
} else ok("admin moderation panel secured");

const start = await get("/api/app-bookings/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    barberName: "Test",
    dateLabel: "Today",
    timeLabel: "10:00 AM",
    redirectUri: "https://example.com/",
    serviceId: 1,
  }),
});
if (start.res.status >= 500) fail("app-bookings/start server error");
else ok(`booking checkout gate (${start.json.error || start.res.status})`);

if (failed) {
  console.error(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log("\nV2 quality verification passed.\n");
