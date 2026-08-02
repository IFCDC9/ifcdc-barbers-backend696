#!/usr/bin/env node
/**
 * Ensure Phase 3C subflags exist on backend696 as false — create only if missing.
 * Does NOT modify existing Phase 2/3 vars, MAIL_FROM, DATABASE_URL, PayPal, etc.
 *
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/ensure-aura-phase3c-flags-off.mjs
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/ensure-aura-phase3c-flags-off.mjs --deploy
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/ensure-aura-phase3c-flags-off.mjs --verify-only
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const PROD = "https://ifcdc-barbers-backend696.onrender.com";

const KEYS = [
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
  // Render returns [{envVar:{key,value}}, ...] or [{key,value},...]
  return (arr || []).map((row) => row.envVar || row).filter((e) => e && e.key);
}

function countKeys(envList, key) {
  return envList.filter((e) => e.key === key).length;
}

async function createIfMissing(envList, key, value) {
  const n = countKeys(envList, key);
  if (n > 1) {
    throw new Error(`DUPLICATE KEY ${key} appears ${n} times — aborting without changes`);
  }
  if (n === 1) {
    const existing = envList.find((e) => e.key === key);
    console.log(`SKIP  ${key} already present (value=${JSON.stringify(existing.value)}) — not modified`);
    return { created: false, key };
  }
  const post = await api(`/services/${SERVICE_ID}/env-vars`, {
    method: "POST",
    body: [{ key, value: String(value) }],
  });
  if (!post.ok) throw new Error(`create ${key} failed HTTP ${post.status}`);
  console.log(`CREATE ${key}=${value}`);
  return { created: true, key };
}

console.log(`\n=== Ensure Phase 3C flags OFF (create-if-missing only) ===`);
console.log(`Service ${SERVICE_ID}\n`);

const before = await listEnvVars();
const beforeCounts = Object.fromEntries(KEYS.map((k) => [k, countKeys(before, k)]));
for (const k of KEYS) {
  if (beforeCounts[k] > 1) {
    console.error(`FAIL duplicate ${k} count=${beforeCounts[k]}`);
    process.exit(1);
  }
}
console.log("Pre-check key counts:", beforeCounts);

if (!VERIFY_ONLY) {
  for (const k of KEYS) {
    await createIfMissing(before, k, "0");
  }
  // Re-list to confirm uniqueness after creates
  const after = await listEnvVars();
  const afterCounts = Object.fromEntries(KEYS.map((k) => [k, countKeys(after, k)]));
  console.log("Post-check key counts:", afterCounts);
  for (const k of KEYS) {
    if (afterCounts[k] !== 1) {
      console.error(`FAIL expected exactly one ${k}, got ${afterCounts[k]}`);
      process.exit(1);
    }
    const v = after.find((e) => e.key === k)?.value;
    if (!["0", "false", "False", "FALSE", "off", "OFF"].includes(String(v))) {
      console.warn(`WARN ${k} exists but value is ${JSON.stringify(v)} (expected falsey); left unchanged per policy`);
    }
  }

  if (DO_DEPLOY) {
    const d = await api(`/services/${SERVICE_ID}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    if (!d.ok) throw new Error(`deploy failed HTTP ${d.status}`);
    console.log("Deploy triggered");
  }
} else {
  console.log("VERIFY_ONLY — no env writes");
}

console.log(`\nVerify ${PROD}/api/aura/phase3/status and ${PROD}/api/aura/phase3/insights/status\n`);
process.exit(0);
