#!/usr/bin/env node
/**
 * Remove HubSpot env vars from the non-canonical Render service
 * ifcdc-barbers-backend696-d8ui so only production manages HubSpot sync.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/render-strip-d8ui-hubspot.mjs
 *   RENDER_API_KEY=rnd_... node scripts/render-strip-d8ui-hubspot.mjs --deploy
 */
const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const D8UI_SERVICE_ID = String(
  process.env.RENDER_D8UI_SERVICE_ID || "srv-d8gn9h77f7vs73evmfgg",
).trim();
const KEYS = [
  "HUBSPOT_SERVICE_KEY",
  "HUBSPOT_SYNC_ENABLED",
  "HUBSPOT_SYNC_COMPANIES",
  "HUBSPOT_SYNC_DEALS",
  "HUBSPOT_SYNC_WORKFLOWS",
  "HUBSPOT_HQ_ANALYTICS",
  "HUBSPOT_DEAL_PIPELINE_ID",
  "HUBSPOT_DEAL_STAGE_PAID",
  "HUBSPOT_DEAL_STAGE_COMPLETED",
  "HUBSPOT_DEAL_STAGE_CANCELLED",
  "HUBSPOT_DEAL_STAGE_NO_SHOW",
];
const DEPLOY = process.argv.includes("--deploy");

if (!TOKEN) {
  console.error(
    "Missing RENDER_API_KEY.\n" +
      "Create one in Render → Account Settings → API Keys, then run:\n" +
      "  RENDER_API_KEY=rnd_... node scripts/render-strip-d8ui-hubspot.mjs --deploy\n" +
      "Or manually delete all HUBSPOT_* keys on service ifcdc-barbers-backend696-d8ui.",
  );
  process.exit(1);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok && res.status !== 204) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, json };
}

console.log(`\nStripping HubSpot env from service ${D8UI_SERVICE_ID}...\n`);

for (const key of KEYS) {
  try {
    const { status } = await api(`/services/${D8UI_SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    console.log(`  ${key}: deleted (${status || 204})`);
  } catch (error) {
    const msg = String(error?.message || error);
    if (/404/.test(msg)) console.log(`  ${key}: already absent`);
    else throw error;
  }
}

if (DEPLOY) {
  console.log("\nTriggering deploy/restart on d8ui...");
  await api(`/services/${D8UI_SERVICE_ID}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  console.log("  deploy requested");
} else {
  console.log("\nEnv vars removed. Re-run with --deploy (or restart the service) to apply.");
}

console.log("\nDone.\n");
