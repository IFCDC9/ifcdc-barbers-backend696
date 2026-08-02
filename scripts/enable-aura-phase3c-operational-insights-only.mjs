#!/usr/bin/env node
/**
 * Enable ONLY AURA_PHASE3_OPERATIONAL_INSIGHTS on backend696 (PUT existing key).
 * Does not create new keys. Keeps dashboard/digest/recommendations false.
 *
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-aura-phase3c-operational-insights-only.mjs
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-aura-phase3c-operational-insights-only.mjs --deploy
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const PROD = "https://ifcdc-barbers-backend696.onrender.com";

const KEEP_FALSE = [
  "AURA_PHASE3_INSIGHTS_DASHBOARD",
  "AURA_PHASE3_INSIGHTS_DAILY_DIGEST",
  "AURA_PHASE3_RECOMMENDATIONS",
];

if (!API_KEY) {
  console.error("Missing RENDER_API_KEY.");
  process.exit(1);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, json };
}

async function listEnvVars() {
  const r = await api(`/services/${SERVICE_ID}/env-vars`);
  if (!r.ok) throw new Error(`list env-vars failed HTTP ${r.status}`);
  const arr = Array.isArray(r.json) ? r.json : r.json?.envVars || r.json || [];
  return (arr || []).map((row) => row.envVar || row).filter((e) => e && e.key);
}

function countKeys(envList, key) {
  return envList.filter((e) => e.key === key).length;
}

async function putExistingOnly(key, value) {
  const put = await api(`/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value: String(value) },
  });
  if (!put.ok) {
    throw new Error(
      `PUT ${key} failed HTTP ${put.status} — will not POST/create (no duplicate policy)`,
    );
  }
  return put;
}

function isFalsey(v) {
  return ["0", "false", "no", "off", ""].includes(String(v || "").trim().toLowerCase());
}

console.log(`\n=== Enable Phase 3C OPERATIONAL_INSIGHTS only ===\nService ${SERVICE_ID}\n`);

const env = await listEnvVars();
const keysToCheck = ["AURA_PHASE3_OPERATIONAL_INSIGHTS", ...KEEP_FALSE];
for (const k of keysToCheck) {
  const n = countKeys(env, k);
  if (n !== 1) {
    console.error(`FAIL ${k} count=${n} (expected exactly 1). Aborting.`);
    process.exit(1);
  }
}

await putExistingOnly("AURA_PHASE3_OPERATIONAL_INSIGHTS", "true");
console.log("PUT AURA_PHASE3_OPERATIONAL_INSIGHTS=true");

// Reaffirm keep-false without creating keys
for (const k of KEEP_FALSE) {
  const cur = env.find((e) => e.key === k)?.value;
  if (!isFalsey(cur)) {
    await putExistingOnly(k, "false");
    console.log(`PUT ${k}=false (was ${JSON.stringify(cur)})`);
  } else {
    console.log(`KEEP ${k}=${JSON.stringify(cur)}`);
  }
}

const after = await listEnvVars();
for (const k of keysToCheck) {
  const n = countKeys(after, k);
  const v = after.find((e) => e.key === k)?.value;
  console.log(`Confirm ${k} count=${n} value=${JSON.stringify(v)}`);
  if (n !== 1) process.exit(1);
}

if (DO_DEPLOY) {
  const d = await api(`/services/${SERVICE_ID}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  if (!d.ok) throw new Error(`deploy failed HTTP ${d.status}`);
  console.log("Deploy triggered");
}

console.log(`\nVerify ${PROD}/api/aura/phase3/status after deploy.\n`);
process.exit(0);
