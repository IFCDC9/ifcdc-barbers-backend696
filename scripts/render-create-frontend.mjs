#!/usr/bin/env node
/**
 * Create or deploy ifcdc-barbers-frontend on Render (requires RENDER_API_KEY).
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... RENDER_OWNER_ID=own_... node scripts/render-create-frontend.mjs
 *
 * Optional:
 *   RENDER_REPO=https://github.com/IFCDC9/ifcdc-barbers-backend696.git
 */
const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const OWNER = String(process.env.RENDER_OWNER_ID || "").trim();
const REPO =
  String(process.env.RENDER_REPO || "https://github.com/IFCDC9/ifcdc-barbers-backend696.git").trim();
const NAME = "ifcdc-barbers-frontend";

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
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function listServices() {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const page = await api(`/services${q}`);
    const rows = Array.isArray(page) ? page : page?.items || [];
    out.push(...rows.map((r) => r?.service || r));
    cursor = page?.cursor;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

async function createStaticSite() {
  if (!OWNER) throw new Error("Set RENDER_OWNER_ID (Render workspace ID from Settings).");
  return api("/services", {
    method: "POST",
    body: {
      type: "static_site",
      name: NAME,
      ownerId: OWNER,
      repo: REPO,
      branch: "main",
      autoDeploy: "yes",
      rootDir: "client",
      envVars: [{ key: "VITE_API_BASE", value: "https://ifcdc-barbers-backend696.onrender.com" }],
      serviceDetails: {
        buildCommand: "npm install && npm run build",
        publishPath: "dist",
        pullRequestPreviewsEnabled: "no",
        routes: [{ type: "rewrite", source: "/*", destination: "/index.html" }],
      },
    },
  });
}

async function triggerDeploy(serviceId) {
  return api(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
}

async function main() {
  if (!TOKEN) {
    console.error("Missing RENDER_API_KEY.");
    process.exit(1);
  }
  const services = await listServices();
  const existing = services.find((s) => s?.name === NAME || s?.service?.name === NAME);
  if (existing) {
    const id = existing.id || existing.service?.id;
    console.log(`Found existing service ${NAME} (${id}). Triggering deploy…`);
    await triggerDeploy(id);
    console.log("Deploy started.");
    return;
  }
  console.log(`Creating static site ${NAME}…`);
  const created = await createStaticSite();
  console.log(JSON.stringify(created, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
