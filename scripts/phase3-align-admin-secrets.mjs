#!/usr/bin/env node
/**
 * Phase 3 — align production ADMIN_SECRET on Render backend696.
 *
 * Requires RENDER_API_KEY. Optionally generates a strong secret or uses ADMIN_SECRET_TO_SET.
 * Does NOT print the secret after set (prints fingerprint only).
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/phase3-align-admin-secrets.mjs --generate --deploy
 *   RENDER_API_KEY=rnd_... ADMIN_SECRET_TO_SET='…' node scripts/phase3-align-admin-secrets.mjs --deploy
 *
 * After success, set the SAME value as VITE_ADMIN_API_KEY on the web frontend build host
 * and redeploy the website.
 */
import crypto from "node:crypto";

const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID ||
    process.env.RENDER_SERVICE_ID ||
    "srv-d6tmai24d50c73cdi0mg",
).trim();
const D8UI_SERVICE_ID = String(
  process.env.RENDER_D8UI_SERVICE_ID || "srv-d8gn9h77f7vs73evmfgg",
).trim();
const GENERATE = process.argv.includes("--generate");
const DEPLOY = process.argv.includes("--deploy");
const STRIP_D8UI = process.argv.includes("--strip-d8ui");

if (!TOKEN) {
  console.error(
    "Missing RENDER_API_KEY.\n" +
      "Render → Account Settings → API Keys, then:\n" +
      "  RENDER_API_KEY=rnd_... node scripts/phase3-align-admin-secrets.mjs --generate --deploy --strip-d8ui\n",
  );
  process.exit(1);
}

function generateSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
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

const secret = GENERATE
  ? generateSecret()
  : String(process.env.ADMIN_SECRET_TO_SET || "").trim();

if (!secret || secret.length < 24) {
  console.error("Provide --generate or ADMIN_SECRET_TO_SET with at least 24 characters.");
  process.exit(1);
}

console.log(`\nSetting ADMIN_SECRET on ${SERVICE_ID}`);
console.log(`Fingerprint (sha256[:12]): ${fingerprint(secret)}`);

await api(`/services/${SERVICE_ID}/env-vars/ADMIN_SECRET`, {
  method: "PUT",
  body: { value: secret },
});
console.log("  ADMIN_SECRET: upserted");

if (STRIP_D8UI) {
  const keys = [
    "HUBSPOT_SERVICE_KEY",
    "HUBSPOT_SYNC_ENABLED",
    "HUBSPOT_SYNC_COMPANIES",
    "HUBSPOT_SYNC_DEALS",
    "HUBSPOT_SYNC_WORKFLOWS",
    "HUBSPOT_HQ_ANALYTICS",
  ];
  console.log(`\nStripping HubSpot env from d8ui ${D8UI_SERVICE_ID}`);
  for (const key of keys) {
    try {
      await api(`/services/${D8UI_SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      console.log(`  ${key}: deleted`);
    } catch (error) {
      if (/404/.test(String(error?.message || error))) console.log(`  ${key}: already absent`);
      else throw error;
    }
  }
}

if (DEPLOY) {
  console.log("\nTriggering deploys...");
  await api(`/services/${SERVICE_ID}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  console.log("  backend696: deploy requested");
  if (STRIP_D8UI) {
    await api(`/services/${D8UI_SERVICE_ID}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    console.log("  d8ui: deploy requested");
  }
}

console.log(`\nNEXT (required):
1. Set VITE_ADMIN_API_KEY to the SAME secret on the web frontend Render/host env.
2. Redeploy the website so the admin client picks it up.
3. Store the secret in your password manager (fingerprint ${fingerprint(secret)}).
4. Do NOT commit the secret. Do NOT put production ADMIN_SECRET in local .env.
`);

if (GENERATE) {
  // Print once so the operator can copy into the password manager + frontend env.
  console.log("GENERATED_ADMIN_SECRET (copy now — not stored in git):");
  console.log(secret);
  console.log("");
}
