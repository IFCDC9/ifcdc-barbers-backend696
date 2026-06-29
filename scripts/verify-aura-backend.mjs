#!/usr/bin/env node
/**
 * Verify AURA backend deployment (health, status, voice probe).
 * Usage: node scripts/verify-aura-backend.mjs [--base URL]
 */
const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.AURA_BACKEND_URL ||
  process.env.AURA_BASE_URL ||
  "https://aura-backend.onrender.com"
).replace(/\/$/, "");

let failed = 0;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK    ${msg}`);
}

async function get(path) {
  const url = `${base}${path}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { res, json, url };
}

console.log(`\nAURA backend verification → ${base}\n`);

const health = await get("/api/health");
if (!health.res.ok) fail(`/api/health HTTP ${health.res.status}`);
else ok(`/api/health ${health.res.status}`);

const auraHealth = await get("/api/health?aura=1");
if (auraHealth.json?.aura?.chat?.openai) ok("OpenAI configured for AURA chat");
else if (auraHealth.res.ok) ok("AURA health payload present (check OPENAI_API_KEY in Render if chat fails)");

const status = await get("/api/aura/status");
if (!status.res.ok) fail(`/api/aura/status HTTP ${status.res.status}`);
else {
  ok(`/api/aura/status ${status.res.status}`);
  const v = status.json?.voice || {};
  if (v.publicBaseUrlConfigured) ok(`voice webhook base configured`);
  else fail("PUBLIC_BASE_URL / RENDER_EXTERNAL_URL not set — Twilio webhooks may fail");
}

const voiceGet = await fetch(`${base}/voice`, { headers: { Accept: "text/xml" } });
if (voiceGet.ok && (await voiceGet.text()).includes("<Response>")) ok("GET /voice returns TwiML");
else fail(`GET /voice HTTP ${voiceGet.status}`);

if (failed) {
  console.error(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log("\nAURA backend checks passed.\n");
