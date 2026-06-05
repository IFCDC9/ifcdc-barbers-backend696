#!/usr/bin/env node
/**
 * Trigger a manual deploy of ifcdc-barbers-backend696 on Render.
 * Requires RENDER_API_KEY and RENDER_BACKEND696_SERVICE_ID in the environment.
 *
 * Get service ID: Render Dashboard → ifcdc-barbers-backend696 → Settings → copy ID from URL.
 */
const API_KEY = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID ||
    process.env.RENDER_SERVICE_ID ||
    "srv-d6tmai24d50c73cdi0mg",
).trim();

if (!API_KEY) {
  console.error("Set RENDER_API_KEY (Render Dashboard → Account → API Keys)");
  process.exit(1);
}
if (!SERVICE_ID) {
  console.error("Set RENDER_BACKEND696_SERVICE_ID to the backend696 service ID");
  process.exit(1);
}

const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ clearCache: "do_not_clear" }),
});

const text = await res.text();
let body = {};
try {
  body = text ? JSON.parse(text) : {};
} catch {
  body = { raw: text };
}

if (!res.ok) {
  console.error("Deploy trigger failed:", res.status, body);
  process.exit(1);
}

console.log("Deploy triggered for ifcdc-barbers-backend696");
console.log("Deploy ID:", body?.id || body?.deploy?.id || "(see Render dashboard)");
console.log("\nAfter deploy completes, run: npm run verify:cleanup");
