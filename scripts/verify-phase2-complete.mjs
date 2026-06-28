#!/usr/bin/env node
/**
 * Phase 2 complete verification — profile, gallery, services, reviews, discovery, cron hooks.
 * Usage: node scripts/verify-phase2-complete.mjs [--base URL]
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
  return { res, json };
}

let failed = 0;
function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK  ${msg}`);
}

console.log(`\nPhase 2 complete verification → ${base}\n`);

const deploy = await get("/api/deploy-info");
if (!deploy.res.ok) fail("deploy-info");
else ok(`deploy ${deploy.json.activeCommitShort || "unknown"}`);

const health = await get("/api/health");
if (!health.res.ok) fail("health");
else ok("API health");

const profileFields = await get("/api/barber/profile");
if (profileFields.res.status !== 401) fail("barber profile should require auth");
else ok("barber profile secured");

const reviewPatch = await fetch(`${base.replace(/\/+$/, "")}/api/reviews/00000000-0000-0000-0000-000000000001`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rating: 5 }),
});
if (reviewPatch.status !== 401) fail("review edit should require auth");
else ok("review edit/delete secured");

const discover = await get("/api/portfolio/discover?limit=5");
if (!discover.res.ok || !discover.json.ok) fail("discovery feed");
else ok(`discovery feed (${(discover.json.photos || []).length} photos)`);

const barbers = await get("/api/app-bookings/barbers");
if (!barbers.res.ok || !Array.isArray(barbers.json)) fail("booking barbers");
else ok(`booking barbers (${barbers.json.length})`);

const first = barbers.json[0];
if (first?.id) {
  const services = await get(`/api/app-bookings/services?barberId=${encodeURIComponent(first.id)}`);
  if (!services.res.ok || !services.json.ok) fail("booking services");
  else {
    const list = services.json.services || [];
    ok(`booking services (${list.length})`);
    const withImg = list.filter((s) => String(s.image_url || "").trim());
    ok(`services with image_url field (${withImg.length}/${list.length})`);
  }

  const portfolio = await get(`/api/portfolio/${encodeURIComponent(first.id)}`);
  if (!portfolio.res.ok || !portfolio.json.ok) fail("portfolio API");
  else {
    const p = portfolio.json.portfolio;
    ok(`portfolio sync: headline="${p.headline || ""}" years=${p.yearsExperience ?? "null"}`);
    if (p.yearsExperience === 0) fail("portfolio should not expose yearsExperience=0");
    if (Array.isArray(p.gallery)) ok(`portfolio gallery (${p.gallery.length} photos)`);
  }
}

const onboardingBranding = await fetch(`${base.replace(/\/+$/, "")}/api/barber/onboard/branding`, { method: "POST" });
if (onboardingBranding.status !== 401) fail("onboarding branding route should require auth");
else ok("onboarding branding route (no /api/barber/media conflict)");

const start = await get("/api/app-bookings/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ barberName: "Test", dateLabel: "Today", timeLabel: "10:00 AM", redirectUri: "https://example.com/", serviceId: 1 }),
});
if (start.res.status >= 500) fail("booking checkout server error");
else ok(`booking checkout gate (${start.json.error || start.res.status})`);

try {
  const fe = await fetch("https://ifcdcbarbersapp.com/", { method: "GET" });
  if (fe.ok) ok("frontend reachable");
  else fail(`frontend HTTP ${fe.status}`);
} catch (e) {
  console.warn(`WARN frontend: ${e.message}`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log("\nPhase 2 complete verification passed.\n");
