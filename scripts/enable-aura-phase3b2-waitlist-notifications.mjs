#!/usr/bin/env node
/**
 * Enable AURA_PHASE3_WAITLIST_NOTIFICATIONS on backend696.
 * Keeps operational insights OFF. Does not open allowlist to all customers.
 *
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-aura-phase3b2-waitlist-notifications.mjs --deploy
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const PROD = "https://ifcdc-barbers-backend696.onrender.com";
const ALLOW =
  process.env.AURA_WAITLIST_NOTIFY_ALLOWLIST ||
  [process.env.BOOKING_ADMIN_EMAIL, process.env.AURA_DAILY_REPORT_TO, "service@ifcdc.org"]
    .filter(Boolean)
    .join(",");

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

console.log(`\n=== Enable Phase 3B2 WAITLIST NOTIFICATIONS ===\nService ${SERVICE_ID}\n`);

if (!VERIFY_ONLY) {
  await putEnv("AURA_PHASE3_WAITLIST", "1");
  await putEnv("AURA_PHASE3_SLOT_RECOVERY", "1");
  await putEnv("AURA_PHASE3_WAITLIST_NOTIFICATIONS", "1");
  await putEnv("AURA_PHASE3_OPERATIONAL_INSIGHTS", "0");
  await putEnv("AURA_WAITLIST_NOTIFY_ALLOWLIST", ALLOW);
  console.log("Set WAITLIST + SLOT_RECOVERY + WAITLIST_NOTIFICATIONS=1");
  console.log("Forced OFF: OPERATIONAL_INSIGHTS");
  console.log(`Allowlist (controlled): ${ALLOW}`);

  if (DO_DEPLOY) {
    const d = await api(`/services/${SERVICE_ID}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    if (!d.ok) throw new Error(`deploy failed HTTP ${d.status}`);
    console.log("Deploy triggered");
  }
}

console.log(`\nVerify ${PROD}/api/aura/phase3/status after deploy.\n`);
process.exit(0);
