#!/usr/bin/env node
/**
 * Enable production transactional SMS on backend696 (+ aura-backend if present).
 * Sets SMS_NOTIFICATIONS_ENABLED=1 only. Does not create Twilio resources.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-sms-notifications-env.mjs
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-sms-notifications-env.mjs --deploy
 *   RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-sms-notifications-env.mjs --verify-only
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const VERIFY_ONLY = process.argv.includes("--verify-only");

const TARGET_NAMES = new Set(["ifcdc-barbers-backend696", "aura-backend"]);
const FLAG_KEY = "SMS_NOTIFICATIONS_ENABLED";
const FLAG_VALUE = "1";
const LIVE_STATUS_URL = "https://ifcdc-barbers-backend696.onrender.com/api/sms/status";

if (!API_KEY) {
  console.error("Missing RENDER_API_KEY.");
  console.error(
    "Then: RENDER_API_KEY=rnd_... node --import ./loadBackendEnv.mjs scripts/enable-sms-notifications-env.mjs --deploy",
  );
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

async function putEnvVar(serviceId, key, value) {
  const { ok, status, json } = await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
  if (!ok) {
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

async function verifyLive() {
  const res = await fetch(LIVE_STATUS_URL, { headers: { Accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    notificationsEnabled: Boolean(json?.flags?.notificationsEnabled),
    verifyEnabled: Boolean(json?.flags?.verifyEnabled),
    messagingConfigured: Boolean(json?.twilio?.messagingConfigured),
  };
}

async function main() {
  if (VERIFY_ONLY) {
    const live = await verifyLive();
    console.log(JSON.stringify({ verifyOnly: true, live }, null, 2));
    process.exit(live.notificationsEnabled ? 0 : 1);
  }

  const services = await listServices();
  const targets = services.filter((s) => TARGET_NAMES.has(String(s.name || "")));
  if (!targets.length) throw new Error("No target Render services found");

  const results = [];
  for (const svc of targets) {
    await putEnvVar(svc.id, FLAG_KEY, FLAG_VALUE);
    let deployId = null;
    if (DO_DEPLOY) deployId = await triggerDeploy(svc.id);
    results.push({ name: svc.name, id: svc.id, set: FLAG_KEY, deployId });
  }

  let live = null;
  if (DO_DEPLOY) {
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      live = await verifyLive();
      if (live.notificationsEnabled) break;
      console.log(`waiting for live flag… poll ${i + 1}`);
    }
  } else {
    live = await verifyLive();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        results,
        live,
        note: DO_DEPLOY
          ? "SMS_NOTIFICATIONS_ENABLED=1 set and deploy triggered"
          : "SMS_NOTIFICATIONS_ENABLED=1 set; redeploy to activate (pass --deploy)",
      },
      null,
      2,
    ),
  );
  if (DO_DEPLOY && !live?.notificationsEnabled) process.exit(1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
