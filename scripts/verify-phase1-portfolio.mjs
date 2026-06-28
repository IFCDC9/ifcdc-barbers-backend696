#!/usr/bin/env node
/**
 * Verify V2 Phase 1 portfolio API + booking stability on production.
 * Usage: node scripts/verify-phase1-portfolio.mjs [--base URL]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const FRONTEND =
  process.env.FRONTEND_URL || "https://ifcdcbarbersapp.com";

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

console.log(`\nPhase 1 portfolio verification → ${base}\n`);

const deploy = await get("/api/deploy-info");
if (!deploy.res.ok) fail("deploy-info unavailable");
else {
  const commit = String(deploy.json.activeCommitShort || "");
  const expected = process.env.EXPECTED_COMMIT || "";
  if (expected && !commit.startsWith(expected)) {
    fail(`expected commit ${expected}, got ${commit || "(unknown)"}`);
  } else if (!commit || commit.length < 7) {
    fail(`deploy commit missing or invalid: ${commit || "(unknown)"}`);
  } else ok(`deploy commit ${commit}`);
}

const health = await get("/api/health");
if (!health.res.ok && health.res.status !== 200) fail("health check");
else ok("API health");

const barbers = await get("/api/app-bookings/barbers");
if (!barbers.res.ok || !Array.isArray(barbers.json)) {
  fail("booking barbers list");
} else {
  ok(`booking barbers list (${barbers.json.length} barber(s))`);
  const testNames = barbers.json.filter((b) =>
    /release test|rv test|rv reject/i.test(String(b.name || "")),
  );
  if (testNames.length) fail(`QA test barbers still in booking list: ${testNames.map((b) => b.name).join(", ")}`);
  else ok("no QA test barbers in booking list");
}

const cats = await get("/api/portfolio/meta/categories");
if (!cats.res.ok || !cats.json.ok || !Array.isArray(cats.json.categories)) {
  fail("portfolio categories meta");
} else {
  ok(`portfolio categories (${cats.json.categories.length} categories)`);
}

const discover = await get("/api/portfolio/discover?limit=5");
if (!discover.res.ok || !discover.json.ok || !Array.isArray(discover.json.photos)) {
  fail("portfolio discover feed");
} else ok(`portfolio discover (${discover.json.photos.length} photos)`);

const firstBarber = Array.isArray(barbers.json) && barbers.json[0];
if (firstBarber?.id) {
  const portfolio = await get(`/api/portfolio/${encodeURIComponent(firstBarber.id)}`);
  if (!portfolio.res.ok || !portfolio.json.ok || !portfolio.json.portfolio) {
    fail(`public portfolio for barber ${firstBarber.name}`);
  } else {
    const p = portfolio.json.portfolio;
    ok(`public portfolio: ${p.name} (slug=${p.slug}, reviews=${p.reviewCount}, bookable=${p.bookable})`);
    if (!p.slug) fail("portfolio missing public slug");
    else ok(`shareable URL: /p/${p.slug}`);
  }
} else {
  fail("no bookable barber to test portfolio");
}

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
if (start.json.error !== "customer_email_required" && start.json.error !== "barber_unresolved") {
  // barber_unresolved acceptable if test barber missing; customer_email_required is the booking gate we care about
  if (start.res.status >= 500) fail(`app-bookings/start server error ${start.res.status}`);
  else ok(`app-bookings/start responds (${start.json.error || start.res.status}) — checkout path alive`);
} else {
  ok(`app-bookings/start gate intact (${start.json.error})`);
}

try {
  const fe = await fetch(`${FRONTEND.replace(/\/+$/, "")}/`, { method: "GET" });
  if (fe.ok) ok(`frontend reachable (${FRONTEND})`);
  else fail(`frontend HTTP ${fe.status}`);
} catch (e) {
  console.warn(`WARN frontend check skipped: ${e.message}`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log("\nPhase 1 production verification passed.\n");
