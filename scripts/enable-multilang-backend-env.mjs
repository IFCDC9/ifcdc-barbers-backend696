#!/usr/bin/env node
/**
 * Enable MULTI_LANGUAGE_DROPDOWN_V2=1 on production backends that send customer emails,
 * then trigger redeploys. Never prints secret values.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/enable-multilang-backend-env.mjs
 *   RENDER_API_KEY=rnd_... node scripts/enable-multilang-backend-env.mjs --deploy
 *   RENDER_API_KEY=rnd_... node scripts/enable-multilang-backend-env.mjs --verify-only
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");

/** Services that can send customer transactional email. */
const TARGET_NAMES = new Set([
  "ifcdc-barbers-backend696",
  "aura-backend",
]);

const FLAG_KEY = "MULTI_LANGUAGE_DROPDOWN_V2";
const FLAG_VALUE = "1";

if (!API_KEY) {
  console.error("Missing RENDER_API_KEY. Create one in Render → Account → API Keys.");
  console.error("Then: RENDER_API_KEY=rnd_... node scripts/enable-multilang-backend-env.mjs --deploy");
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
  const { ok, status, json } = await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`);
  if (status === 404) return null;
  if (!ok) throw new Error(`get env ${key} HTTP ${status}`);
  return json?.envVar || json;
}

async function putEnvVar(serviceId, key, value) {
  const { ok, status, json } = await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
  if (!ok) {
    // Some Render plans use POST upsert
    const create = await api(`/services/${serviceId}/env-vars`, {
      method: "POST",
      body: [{ key, value }],
    });
    if (!create.ok) {
      throw new Error(`set env ${key} failed PUT=${status} POST=${create.status}`);
    }
    return create.json;
  }
  return json;
}

async function triggerDeploy(serviceId) {
  const { ok, status, json } = await api(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  if (!ok) throw new Error(`deploy HTTP ${status}: ${JSON.stringify(json)}`);
  return json?.id || json?.deploy?.id || null;
}

async function verifyLiveFlag(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/deploy-info`, {
      headers: { Accept: "application/json" },
    });
    const json = await res.json();
    return {
      ok: res.ok,
      enabled: Boolean(json?.multiLanguage?.enabled || json?.features?.multiLanguageDropdownV2),
      commit: json?.activeCommitShort || null,
      service: json?.service || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const services = await listServices();
const targets = services.filter((s) => TARGET_NAMES.has(String(s.name || "")));

if (!targets.length) {
  console.error("No matching services found among:", [...TARGET_NAMES].join(", "));
  process.exit(1);
}

console.log(`\nMULTI_LANGUAGE_DROPDOWN_V2 on email-sending backends\n`);

for (const svc of targets) {
  const id = svc.id;
  const name = svc.name;
  const url = svc.serviceDetails?.url || svc.url || null;
  process.stdout.write(`• ${name} (${id}) … `);

  if (VERIFY_ONLY) {
    const existing = await getEnvVar(id, FLAG_KEY);
    const val = existing?.value != null ? String(existing.value) : null;
    const on = val === "1" || /^true|yes|on$/i.test(String(val || ""));
    console.log(on ? `env=ON` : `env=${val == null ? "MISSING" : "OFF"}`);
    continue;
  }

  await putEnvVar(id, FLAG_KEY, FLAG_VALUE);
  let deployId = null;
  if (DO_DEPLOY) {
    deployId = await triggerDeploy(id);
  }
  console.log(`env=SET${DO_DEPLOY ? ` deploy=${deployId || "queued"}` : " (no deploy)"}`);
}

if (!VERIFY_ONLY && DO_DEPLOY) {
  console.log("\nWaiting ~45s then verifying live deploy-info flag…");
  await new Promise((r) => setTimeout(r, 45000));
  const live = await verifyLiveFlag("https://ifcdc-barbers-backend696.onrender.com");
  console.log("backend696 live:", live);
}

console.log(`
Done.
Frontend alignment:
  Web:    VITE_MULTI_LANGUAGE_DROPDOWN_V2=1 (baked in Render frontend build)
  Mobile: EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2=1 (EAS production profile)
  Shared codes: en, es, fr, ht, pt, ar, zh-CN, ko, vi
`);
