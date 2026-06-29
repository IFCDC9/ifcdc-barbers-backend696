#!/usr/bin/env node
/**
 * Fix misconfigured aura-backend on Render:
 * - Repo: IFCDC9/ifcdc-barbers-backend696 (NOT ifcdc-barbers-backend)
 * - Root: repo root (NOT client/) — runs server.js with AURA + Twilio routes
 * - Ignores client/mobile-only commits so frontend deploys do not break this service
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/render-fix-aura-backend.mjs
 *   RENDER_API_KEY=rnd_... node scripts/render-fix-aura-backend.mjs --deploy
 */
const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_NAME = "aura-backend";
const CORRECT_REPO = String(
  process.env.RENDER_REPO || "https://github.com/IFCDC9/ifcdc-barbers-backend696.git",
).trim();
const DEPLOY = process.argv.includes("--deploy");

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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

async function listServices() {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const page = await api(`/services${q}`);
    const rows = Array.isArray(page) ? page : page?.items || [];
    for (const row of rows) {
      out.push(row?.service || row);
    }
    cursor = page?.cursor;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

function unwrapService(s) {
  return s?.service || s;
}

async function main() {
  if (!TOKEN) {
    console.error("Set RENDER_API_KEY (Render Dashboard → Account → API Keys)");
    process.exit(1);
  }

  const services = await listServices();
  const svc = services.find((s) => String(unwrapService(s)?.name || "") === SERVICE_NAME);
  if (!svc) {
    console.error(`Service "${SERVICE_NAME}" not found. Create it from render.yaml Blueprint or Render dashboard.`);
    process.exit(1);
  }

  const service = unwrapService(svc);
  const id = service.id;
  console.log(`\nFound ${SERVICE_NAME} (${id})`);
  console.log("Current:", {
    repo: service.repo,
    branch: service.branch,
    rootDir: service.rootDir || "(repo root)",
    type: service.type,
    suspended: service.suspended,
  });

  const patchBody = {
    repo: CORRECT_REPO,
    branch: "main",
    autoDeploy: "yes",
    rootDir: "",
    buildFilter: {
      paths: [
        "**/*.js",
        "**/*.mjs",
        "**/*.cjs",
        "**/*.ts",
        "package.json",
        "package-lock.json",
      ],
      ignoredPaths: ["client/**", "mobile/**", "frontend/**", "docs/**"],
    },
    serviceDetails: {
      env: "node",
      buildCommand: "npm install && npm run build",
      startCommand: "npm start",
      healthCheckPath: "/api/aura/status",
      pullRequestPreviewsEnabled: "no",
    },
  };

  console.log("\nPatching service configuration…");
  const updated = await api(`/services/${id}`, { method: "PATCH", body: patchBody });
  const u = unwrapService(updated) || updated;
  console.log("Updated:", {
    repo: u.repo,
    rootDir: u.rootDir || "(repo root)",
    buildCommand: u.serviceDetails?.buildCommand,
    startCommand: u.serviceDetails?.startCommand,
    healthCheckPath: u.serviceDetails?.healthCheckPath,
  });

  if (DEPLOY) {
    console.log("\nTriggering manual deploy (main, latest commit)…");
    const deploy = await api(`/services/${id}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    console.log("Deploy started:", deploy?.id || deploy?.deploy?.id || "(see Render dashboard)");
  } else {
    console.log("\nDry run complete. Re-run with --deploy to trigger a new deploy.");
  }

  console.log("\nAfter deploy, verify:");
  console.log("  node scripts/verify-aura-backend.mjs --base https://<aura-backend-host>.onrender.com");
  console.log("Dashboard: https://dashboard.render.com/web/" + id);
}

main().catch((e) => {
  console.error("[render-fix-aura-backend] FAIL:", e?.message || e);
  process.exit(1);
});
