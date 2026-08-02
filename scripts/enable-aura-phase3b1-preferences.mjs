#!/usr/bin/env node
/**
 * Controlled enable of AURA_PHASE3_CUSTOMER_PREFERENCES on backend696 only.
 * Leaves AURA_PHASE3_PREFERENCE_SUGGESTIONS false.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-aura-phase3b1-preferences.mjs --deploy
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-aura-phase3b1-preferences.mjs --verify-only
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const PROD = "https://ifcdc-barbers-backend696.onrender.com";

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

async function putEnv(key, value) {
  const put = await api(`/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value: String(value) },
  });
  if (put.ok) return put;
  const post = await api(`/services/${SERVICE_ID}/env-vars`, {
    method: "POST",
    body: [{ key, value: String(value) }],
  });
  if (!post.ok) throw new Error(`set ${key} failed PUT=${put.status} POST=${post.status}`);
  return post;
}

async function getEnv(key) {
  const r = await api(`/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get ${key} HTTP ${r.status}`);
  const env = r.json?.envVar || r.json;
  return env?.value ?? null;
}

console.log(`\n=== Enable Phase 3B1 preferences (suggestions stay OFF) ===\nService ${SERVICE_ID}\n`);

if (!VERIFY_ONLY) {
  await putEnv("AURA_PHASE3_CUSTOMER_PREFERENCES", "1");
  await putEnv("AURA_PHASE3_PREFERENCE_SUGGESTIONS", "0");
  console.log("Set AURA_PHASE3_CUSTOMER_PREFERENCES=1");
  console.log("Set AURA_PHASE3_PREFERENCE_SUGGESTIONS=0");

  // Confirm suggestions / deferred flags not accidentally on
  for (const k of [
    "AURA_PHASE3_PREFERENCE_SUGGESTIONS",
    "AURA_PHASE3_WAITLIST",
    "AURA_PHASE3_SLOT_RECOVERY",
    "AURA_PHASE3_OPERATIONAL_INSIGHTS",
  ]) {
    const v = await getEnv(k);
    const on = ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());
    if (on) {
      await putEnv(k, "0");
      console.log(`Forced ${k}=0 (was on)`);
    } else {
      console.log(`OK ${k} remains off`);
    }
  }

  if (DO_DEPLOY) {
    const d = await api(`/services/${SERVICE_ID}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    if (!d.ok) throw new Error(`deploy failed HTTP ${d.status}`);
    console.log("Deploy triggered");
  } else {
    console.log("Env updated (no --deploy). Render may auto-redeploy on env change.");
  }
}

console.log(`\nVerify live flags at ${PROD}/api/aura/phase3/status after deploy completes.\n`);
process.exit(0);
