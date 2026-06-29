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
const SYNC_ENV = !process.argv.includes("--no-sync-env");
const SOURCE_SERVICE_NAME = process.env.RENDER_SOURCE_SERVICE || "ifcdc-barbers-backend696";
const ENV_KEYS_TO_COPY = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
  "JWT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_STORAGE_BUCKET",
  "RESEND_API_KEY",
  "MAIL_FROM",
  "GOOGLE_CLIENT_ID",
  "AURA_PHONE_NUMBER",
  "BUSINESS_PHONE",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_ENV",
  "NODE_ENV",
  "SKIP_VITE_ENV_VALIDATION",
];

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

async function listEnvVars(serviceId) {
  const rows = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const page = await api(`/services/${serviceId}/env-vars${q}`);
    const items = Array.isArray(page) ? page : page?.items || [];
    for (const row of items) {
      const ev = row?.envVar || row;
      if (ev?.key) rows.push(ev);
    }
    cursor = page?.cursor;
    if (!cursor || items.length === 0) break;
  }
  return rows;
}

async function putEnvVar(serviceId, key, value) {
  await api(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: [{ key, value: String(value) }],
  });
}

async function syncEnvFromSource(targetId, sourceId, auraPublicUrl) {
  const sourceVars = await listEnvVars(sourceId);
  const byKey = new Map(sourceVars.map((v) => [v.key, v.value]));
  let copied = 0;
  for (const key of ENV_KEYS_TO_COPY) {
    const val = byKey.get(key);
    if (val != null && String(val).trim() !== "") {
      await putEnvVar(targetId, key, val);
      copied += 1;
      console.log(`[env] copied ${key}`);
    }
  }
  if (auraPublicUrl) {
    await putEnvVar(targetId, "PUBLIC_BASE_URL", auraPublicUrl.replace(/\/$/, ""));
    console.log("[env] set PUBLIC_BASE_URL");
    copied += 1;
  }
  await putEnvVar(targetId, "SKIP_VITE_ENV_VALIDATION", "true");
  await putEnvVar(targetId, "NODE_ENV", "production");
  console.log(`[env] synced ${copied} variable(s) from ${SOURCE_SERVICE_NAME}`);
}

async function getLatestDeploy(serviceId) {
  const page = await api(`/services/${serviceId}/deploys?limit=1`);
  const rows = Array.isArray(page) ? page : page?.items || [];
  const d = rows[0]?.deploy || rows[0];
  return d || null;
}

async function waitForDeployLive(serviceId, deployId, maxMs = 15 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const d = await getLatestDeploy(serviceId);
    const status = String(d?.status || "").toLowerCase();
    const id = d?.id || deployId;
    console.log(`[deploy] ${id} status=${status || "?"}`);
    if (status === "live") return d;
    if (status === "build_failed" || status === "update_failed" || status === "canceled") {
      throw new Error(`Deploy failed: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error("Timed out waiting for deploy to go live");
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
  const auraUrl =
    service.serviceDetails?.url ||
    (service.slug ? `https://${service.slug}.onrender.com` : "https://aura-backend.onrender.com");

  const sourceSvc = services.find((s) => String(unwrapService(s)?.name || "") === SOURCE_SERVICE_NAME);
  const sourceId = sourceSvc ? unwrapService(sourceSvc).id : process.env.RENDER_BACKEND696_SERVICE_ID;

  console.log(`\nFound ${SERVICE_NAME} (${id})`);
  console.log("Current:", {
    repo: service.repo,
    branch: service.branch,
    rootDir: service.rootDir || "(repo root)",
    type: service.type,
    suspended: service.suspended,
    url: auraUrl,
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

  if (SYNC_ENV && sourceId) {
    console.log(`\nSyncing env vars from ${SOURCE_SERVICE_NAME} (${sourceId})…`);
    await syncEnvFromSource(id, sourceId, auraUrl);
  } else if (SYNC_ENV) {
    console.warn(`\nWARN: source service ${SOURCE_SERVICE_NAME} not found — set env vars manually in dashboard`);
  }

  let deployId = null;
  if (DEPLOY) {
    console.log("\nTriggering manual deploy (main, latest commit)…");
    const deploy = await api(`/services/${id}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    deployId = deploy?.id || deploy?.deploy?.id;
    console.log("Deploy started:", deployId || "(see Render dashboard)");
    console.log("\nWaiting for deploy to go live…");
    await waitForDeployLive(id, deployId);
    console.log("\nDeploy status: LIVE");
  } else {
    console.log("\nDry run complete. Re-run with --deploy to trigger a new deploy.");
  }

  console.log("\nVerifying endpoints…");
  const base = auraUrl.replace(/\/$/, "");
  const checks = [
    ["/api/health", (r) => r.res.ok],
    ["/api/aura/status", (r) => r.res.ok && r.json?.ok !== false],
    ["/voice", async (r) => r.res.ok && String(r.text || "").includes("<Response>")],
  ];
  for (const [path, pred] of checks) {
    const url = `${base}${path}`;
    const res = await fetch(url, { headers: { Accept: "*/*" } });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* xml */
    }
    const row = { res, json, text };
    const pass = typeof pred === "function" ? await pred(row) : false;
    console.log(`${pass ? "OK" : "FAIL"}  ${path} → HTTP ${res.status}`);
    if (!pass) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[render-fix-aura-backend] FAIL:", e?.message || e);
  process.exit(1);
});
