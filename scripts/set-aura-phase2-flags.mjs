#!/usr/bin/env node
/**
 * Set AURA Phase 2 feature flags on Render (backend696 + optional aura-backend).
 * Never prints secret values other than confirming key names.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-phase2-flags.mjs
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-phase2-flags.mjs --deploy
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-phase2-flags.mjs --verify-only
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-phase2-flags.mjs --master-on
 *
 * Default: all Phase 2 flags = "false" (including master).
 * --master-on: sets AURA_PHASE2_ENABLED=true while keeping all subflags false.
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const MASTER_ON = process.argv.includes("--master-on");

const TARGET_NAMES = new Set(["ifcdc-barbers-backend696", "aura-backend"]);
const SERVICE_ID_FALLBACK = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();

const FLAGS = {
  AURA_PHASE2_ENABLED: MASTER_ON ? "true" : "false",
  AURA_PHASE2_REMINDERS_24H: "false",
  AURA_PHASE2_REMINDERS_2H: "false",
  AURA_PHASE2_REMINDERS_30M: "false",
  AURA_PHASE2_BARBER_NOTIFY: "false",
  AURA_PHASE2_ADMIN_ALERTS: "false",
  AURA_PHASE2_TOOLS_ENABLED: "false",
  AURA_PHASE2_REVIEW_FOLLOWUP: "false",
  AURA_PHASE2_RESCHEDULE_EMAIL: "false",
  AURA_DAILY_REPORT_PREVIEW: "false",
  AURA_DAILY_REPORT_ENABLED: "false",
};

if (!API_KEY) {
  console.error("Missing RENDER_API_KEY. Create one in Render → Account → API Keys.");
  console.error("Then: RENDER_API_KEY=rnd_... node scripts/set-aura-phase2-flags.mjs --deploy");
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
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, ok: res.ok, json };
}

function unwrapService(row) {
  return row?.service || row;
}

async function listServices() {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const { ok, json, status } = await api(`/services${q}`);
    if (!ok) throw new Error(`list services HTTP ${status}: ${JSON.stringify(json)}`);
    const batch = Array.isArray(json) ? json : json?.items || [];
    for (const row of batch) out.push(unwrapService(row));
    cursor = json?.cursor || "";
    if (!cursor || !batch.length) break;
  }
  return out;
}

async function getEnvVar(serviceId, key) {
  const { ok, status, json } = await api(
    `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
  );
  if (status === 404) return null;
  if (!ok) throw new Error(`get env ${key} HTTP ${status}: ${JSON.stringify(json)}`);
  return json?.envVar || json;
}

async function putEnvVar(serviceId, key, value) {
  const { ok, status, json } = await api(
    `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    { method: "PUT", body: { value } },
  );
  if (!ok) throw new Error(`put env ${key} HTTP ${status}: ${JSON.stringify(json)}`);
  return json?.envVar || json;
}

async function triggerDeploy(serviceId, name) {
  const { ok, status, json } = await api(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  if (!ok) throw new Error(`deploy ${name} HTTP ${status}: ${JSON.stringify(json)}`);
  return json?.id || json?.deploy?.id || null;
}

async function verifyService(serviceId, name) {
  const rows = [];
  for (const [key, expected] of Object.entries(FLAGS)) {
    const env = await getEnvVar(serviceId, key);
    const actual = env?.value ?? null;
    rows.push({
      service: name,
      key,
      expected,
      actual,
      ok: actual === expected,
    });
  }
  return rows;
}

const services = await listServices();
const targets = services.filter((s) => TARGET_NAMES.has(String(s?.name || "")));
if (!targets.length) {
  const fallback = services.find((s) => String(s?.id || "") === SERVICE_ID_FALLBACK);
  if (fallback) targets.push(fallback);
}
if (!targets.length) {
  console.error("No matching Render services found (expected ifcdc-barbers-backend696).");
  process.exit(1);
}

console.log(
  `Mode: ${VERIFY_ONLY ? "verify-only" : MASTER_ON ? "master-on + subflags false" : "all flags false"}`,
);
console.log(
  "Targets:",
  targets.map((s) => `${s.name} (${s.id})`).join(", "),
);

if (!VERIFY_ONLY) {
  for (const svc of targets) {
    for (const [key, value] of Object.entries(FLAGS)) {
      await putEnvVar(svc.id, key, value);
      console.log(`SET ${svc.name} ${key}=${value}`);
    }
  }
}

const verifications = [];
for (const svc of targets) {
  verifications.push(...(await verifyService(svc.id, svc.name)));
}

const failed = verifications.filter((r) => !r.ok);
for (const r of verifications) {
  console.log(
    `${r.ok ? "OK" : "MISMATCH"} ${r.service} ${r.key} expected=${r.expected} actual=${r.actual ?? "(missing)"}`,
  );
}

if (failed.length) {
  console.error(`Verification failed: ${failed.length} mismatch(es)`);
  process.exit(1);
}

if (DO_DEPLOY && !VERIFY_ONLY) {
  for (const svc of targets) {
    const id = await triggerDeploy(svc.id, svc.name);
    console.log(`Deploy triggered: ${svc.name} deployId=${id || "(see dashboard)"}`);
  }
}

console.log("Done. MAIL_FROM was not modified.");
