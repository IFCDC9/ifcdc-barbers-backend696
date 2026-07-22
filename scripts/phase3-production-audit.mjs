#!/usr/bin/env node
/**
 * Phase 3 production configuration + module audit (read-only).
 *
 * Usage:
 *   node scripts/phase3-production-audit.mjs
 *   API_BASE=https://ifcdc-barbers-backend696.onrender.com node scripts/phase3-production-audit.mjs
 */
const API = String(
  process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com",
).replace(/\/+$/, "");
const D8UI = String(
  process.env.D8UI_BASE || "https://ifcdc-barbers-backend696-d8ui.onrender.com",
).replace(/\/+$/, "");
const WEB = String(process.env.WEB_BASE || "https://ifcdcbarbersapp.com").replace(/\/+$/, "");

let failed = 0;
let warned = 0;

function pass(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function warn(name, detail = "") {
  warned += 1;
  console.log(`WARN  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, 200) };
}

console.log(`\n=== Phase 3 production audit ===\nAPI ${API}\nD8UI ${D8UI}\nWEB ${WEB}\n`);

const health = await get(`${API}/api/health`);
if (health.status === 200 && (health.json?.status === "OK" || health.json?.ok === true)) {
  pass("API health");
} else fail("API health", `http ${health.status}`);

const deploy = await get(`${API}/api/deploy-info`);
const d = deploy.json || {};
if (deploy.status === 200 && (d.activeCommitShort || d.activeCommit)) {
  pass("Deploy info", `commit ${d.activeCommitShort || d.activeCommit}`);
} else fail("Deploy info", `http ${deploy.status}`);

if (d.adminSecretConfigured === true) pass("ADMIN_SECRET configured on API");
else fail("ADMIN_SECRET configured on API", "adminSecretConfigured=false — set ADMIN_SECRET on Render backend696");

if (d.jwtSecretConfigured === true) pass("JWT secret configured on API");
else if (d.jwtSecretConfigured === false) fail("JWT secret configured on API");
else warn("JWT secret configured on API", "jwtSecretConfigured not yet on this deploy — redeploy after deployInfo update");

const pay = await get(`${API}/api/app-bookings/health`);
const payEnv = pay.json?.environment || pay.json?.paypal?.environment;
if (pay.status === 200 && pay.json?.ok !== false && String(payEnv).toLowerCase() === "live") {
  pass("PayPal live", String(payEnv));
} else fail("PayPal live", `http ${pay.status} env=${payEnv}`);

const hs = await get(`${API}/api/hubspot/status`);
if (hs.json?.ok && hs.json?.syncEnabled === true && hs.json?.canonicalRuntime === true) {
  pass("HubSpot canonical sync", `phases=${JSON.stringify(hs.json.phases || {})}`);
} else fail("HubSpot canonical sync", JSON.stringify({ ok: hs.json?.ok, sync: hs.json?.syncEnabled }));

const d8 = await get(`${D8UI}/api/hubspot/status`);
const d8Env = d8.json?.hubspotEnvNamesPresent || [];
if (d8.json?.syncEnabled === false && d8.json?.canonicalRuntime === false) {
  if (d8Env.length === 0) pass("d8ui HubSpot env stripped");
  else warn("d8ui HubSpot env stripped", `sync disabled but env still present: ${JSON.stringify(d8Env)} — run render-strip-d8ui-hubspot.mjs --deploy`);
} else fail("d8ui HubSpot isolated", `syncEnabled=${d8.json?.syncEnabled}`);

const slots = await get(
  `${API}/api/app-bookings/available-slots?barberName=${encodeURIComponent("IFCDC Barbers")}&dateLabel=Today&durationMinutes=30`,
);
const slotList = Array.isArray(slots.json?.slots) ? slots.json.slots : [];
if (slots.status === 200 && slots.json?.ok !== false && slotList.length > 0) {
  const available = slotList.filter((s) => s?.available !== false).length;
  pass("Available slots", `${available}/${slotList.length} available tz=${slots.json?.timezone || "?"}`);
} else fail("Available slots", `http ${slots.status}`);

const cats = await get(`${API}/api/portfolio/meta/categories`);
const disc = await get(`${API}/api/portfolio/discover?limit=5`);
if (cats.status === 200 && (cats.json?.categories?.length || 0) >= 8) {
  pass("Discover categories", `${cats.json.categories.length} categories`);
} else fail("Discover categories", `http ${cats.status}`);
if (disc.status === 200 && disc.json?.ok !== false) {
  pass("Discover feed", `${disc.json?.photos?.length ?? disc.json?.items?.length ?? 0} photos`);
} else fail("Discover feed", `http ${disc.status}`);

for (const path of ["/booking", "/discover", "/rewards", "/styles"]) {
  const res = await fetch(`${WEB}${path}`, { redirect: "follow" });
  if (res.ok) pass(`Web ${path}`, `http ${res.status}`);
  else fail(`Web ${path}`, `http ${res.status}`);
}

console.log(
  failed
    ? `\nRESULT: ${failed} failure(s), ${warned} warning(s)\n`
    : `\nRESULT: all required checks passed (${warned} warning(s))\n`,
);
process.exit(failed ? 1 : 0);
