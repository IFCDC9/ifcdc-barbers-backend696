#!/usr/bin/env node
/**
 * Set only AURA daily-report recurring env on ifcdc-barbers-backend696.
 * Does not touch MAIL_FROM, PayPal, DATABASE_URL, or other AURA feature flags.
 *
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-daily-report-schedule.mjs
 *   RENDER_API_KEY=rnd_... node scripts/set-aura-daily-report-schedule.mjs --deploy
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const DO_DEPLOY = process.argv.includes("--deploy");
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();

const VARS = {
  AURA_DAILY_REPORT_ENABLED: "true",
  AURA_DAILY_REPORT_PREVIEW: "true",
  AURA_DAILY_REPORT_HOUR: String(process.env.AURA_DAILY_REPORT_HOUR || "7"),
  AURA_DAILY_REPORT_MINUTE: String(process.env.AURA_DAILY_REPORT_MINUTE || "0"),
  AURA_DAILY_REPORT_TO: String(process.env.AURA_DAILY_REPORT_TO || "service@ifcdc.org"),
  SHOP_TIMEZONE: String(process.env.SHOP_TIMEZONE || "America/New_York"),
};

if (!API_KEY) {
  console.error("Missing RENDER_API_KEY.");
  console.error("Set the following on Render → ifcdc-barbers-backend696 → Environment:");
  for (const [k, v] of Object.entries(VARS)) console.error(`  ${k}=${v}`);
  console.error("Then redeploy (or: RENDER_API_KEY=… node scripts/set-aura-daily-report-schedule.mjs --deploy)");
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

async function putEnv(key, value) {
  const { ok, status, json } = await api(
    `/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`,
    { method: "PUT", body: { value } },
  );
  if (!ok) throw new Error(`put ${key} HTTP ${status}: ${JSON.stringify(json)}`);
  return true;
}

const results = [];
for (const [key, value] of Object.entries(VARS)) {
  await putEnv(key, value);
  results.push({ key, value, ok: true });
}

let deployId = null;
if (DO_DEPLOY) {
  const { ok, status, json } = await api(`/services/${SERVICE_ID}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  if (!ok) throw new Error(`deploy HTTP ${status}: ${JSON.stringify(json)}`);
  deployId = json?.id || json?.deploy?.id || null;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      serviceId: SERVICE_ID,
      service: "ifcdc-barbers-backend696",
      updated: results,
      deployTriggered: DO_DEPLOY,
      deployId,
      note: "Other AURA flags / MAIL_FROM / PayPal / DATABASE_URL were not modified by this script.",
    },
    null,
    2,
  ),
);
