#!/usr/bin/env node
/**
 * LOCAL ONLY — set Voicebox tunnel env on ifcdc-barbers-backend696 via Render API.
 * Never prints VOICEBOX_TUNNEL_SECRET. Compares sha256 prefixes only.
 * Forces VOICEBOX_PRIMARY=0. Does not target tunnel rebuild or Aura memory.
 *
 *   RENDER_API_KEY=… node scripts/local-only/set-render-voicebox-tunnel.mjs --deploy --wait
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_NAME = "ifcdc-barbers-backend696";
const SERVICE_ID_FALLBACK = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const WANTED_BASE = "https://aura-voice.ifcdcbarbersapp.com";
const DO_DEPLOY = process.argv.includes("--deploy");
const DO_WAIT = process.argv.includes("--wait");
const ALSO_AURA_BACKEND = process.argv.includes("--also-aura-backend");

function sha8(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 8);
}

function macSecretPath() {
  const envFile = String(process.env.VOICEBOX_TUNNEL_SECRET_FILE || "").trim();
  if (envFile) return envFile;
  return join(homedir(), "Library/Application Support/ifcdc-aura-voice/data/aura-voicebox-tunnel.secret");
}

function loadMacSecret() {
  const env = String(process.env.VOICEBOX_TUNNEL_SECRET || "").trim();
  if (env) return env;
  const p = macSecretPath();
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const repo = join(process.cwd(), "data/aura-voicebox-tunnel.secret");
  if (existsSync(repo)) return readFileSync(repo, "utf8").trim();
  return "";
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

async function listEnvVars(serviceId) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const { ok, status, json } = await api(`/services/${serviceId}/env-vars?${q}`);
    if (!ok) throw new Error(`list env-vars HTTP ${status}`);
    const rows = Array.isArray(json) ? json : json?.items || [];
    for (const row of rows) {
      const ev = row?.envVar || row;
      if (ev?.key) out.push({ key: ev.key, value: ev.value });
    }
    cursor = json?.cursor;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

async function putEnvVar(serviceId, key, value) {
  const put = await api(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
  if (put.ok) return "PUT";
  const create = await api(`/services/${serviceId}/env-vars`, {
    method: "POST",
    body: [{ key, value }],
  });
  if (!create.ok) throw new Error(`set ${key} failed PUT=${put.status} POST=${create.status}`);
  return "POST";
}

async function findService(name, fallbackId) {
  const listed = await api("/services?limit=100");
  if (listed.ok && Array.isArray(listed.json)) {
    for (const row of listed.json) {
      const svc = row?.service || row;
      if (String(svc?.name || "") === name) return { id: String(svc.id), name, found: true };
    }
  }
  return fallbackId ? { id: fallbackId, name, found: false } : null;
}

async function waitLive(serviceId, deployId, maxMs = 12 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const { ok, json } = await api(`/services/${serviceId}/deploys/${encodeURIComponent(deployId)}`);
    const d = json?.deploy || json;
    const status = String(d?.status || "").toLowerCase();
    console.log(`[deploy] ${deployId} status=${status || "?"}`);
    if (status === "live") return d;
    if (["build_failed", "update_failed", "canceled", "cancelled"].includes(status)) {
      throw new Error(`Deploy failed: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("Timed out waiting for deploy");
}

async function syncService(svc, macSecret, macHash) {
  const vars = await listEnvVars(svc.id);
  const byKey = new Map(vars.map((v) => [v.key, v.value]));
  const currentBase = String(byKey.get("VOICEBOX_BASE_URL") || "").trim().replace(/\/$/, "");
  const currentPrimary = String(byKey.get("VOICEBOX_PRIMARY") ?? "").trim();
  const currentSecret = String(byKey.get("VOICEBOX_TUNNEL_SECRET") || "").trim();
  const renderHash = currentSecret ? sha8(currentSecret) : null;
  const match = Boolean(currentSecret) && renderHash === macHash;

  const changes = [];
  if (currentBase !== WANTED_BASE) changes.push("VOICEBOX_BASE_URL");
  if (currentPrimary !== "0") changes.push("VOICEBOX_PRIMARY");
  if (!match) changes.push("VOICEBOX_TUNNEL_SECRET");

  console.log(
    JSON.stringify(
      {
        service: svc.name,
        serviceId: svc.id,
        baseUrlSet: currentBase === WANTED_BASE ? "yes" : "no",
        currentBaseUrl: currentBase || "(unset)",
        wantedBaseUrl: WANTED_BASE,
        voiceboxPrimary: currentPrimary === "" ? "(unset→code default 0)" : currentPrimary,
        secretPresent: Boolean(currentSecret),
        macSecretSha256_8: macHash,
        renderSecretSha256_8: renderHash,
        secretMatch: match ? "yes" : "no",
        changes,
      },
      null,
      2,
    ),
  );

  if (!changes.length) {
    console.log(`[env] ${svc.name} already aligned; no Render env write`);
    return { changed: false, match, baseSet: currentBase === WANTED_BASE };
  }

  if (changes.includes("VOICEBOX_BASE_URL")) await putEnvVar(svc.id, "VOICEBOX_BASE_URL", WANTED_BASE);
  await putEnvVar(svc.id, "VOICEBOX_PRIMARY", "0");
  if (changes.includes("VOICEBOX_TUNNEL_SECRET")) {
    await putEnvVar(svc.id, "VOICEBOX_TUNNEL_SECRET", macSecret);
  }
  console.log(`[env] wrote ${changes.join(", ")} on ${svc.name} (values not logged)`);
  return { changed: true, match: true, baseSet: true, serviceId: svc.id };
}

if (!TOKEN) {
  console.error("Missing RENDER_API_KEY. Tessa must paste the SAME Mac tunnel secret on Render as VOICEBOX_TUNNEL_SECRET, set VOICEBOX_BASE_URL=https://aura-voice.ifcdcbarbersapp.com, and keep VOICEBOX_PRIMARY=0.");
  console.error("Then: RENDER_API_KEY=… node scripts/local-only/set-render-voicebox-tunnel.mjs --deploy --wait");
  process.exit(2);
}

const macSecret = loadMacSecret();
if (!macSecret) {
  console.error("Mac VOICEBOX_TUNNEL_SECRET file missing — cannot align Render.");
  process.exit(2);
}
const macHash = sha8(macSecret);

const backend = await findService(SERVICE_NAME, SERVICE_ID_FALLBACK);
if (!backend?.id) {
  console.error(`Service ${SERVICE_NAME} not found`);
  process.exit(1);
}

const results = [await syncService(backend, macSecret, macHash)];
if (ALSO_AURA_BACKEND) {
  const aura = await findService("aura-backend", null);
  if (aura?.id) results.push(await syncService(aura, macSecret, macHash));
  else console.log("[env] aura-backend not found — skipped (backend696 serves voice)");
}

const needDeploy = results.some((r) => r.changed);
if (needDeploy && DO_DEPLOY) {
  const deploy = await api(`/services/${backend.id}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  if (!deploy.ok) throw new Error(`deploy HTTP ${deploy.status}`);
  const deployId = deploy.json?.id || deploy.json?.deploy?.id || "queued";
  console.log(`Deploy triggered on ${SERVICE_NAME}: ${deployId}`);
  if (DO_WAIT && deployId !== "queued") await waitLive(backend.id, deployId);
} else if (needDeploy) {
  console.log("Env changed. Re-run with --deploy --wait (or Manual Deploy) so backend696 picks it up.");
} else {
  console.log("No deploy — env already matched.");
}
console.log("VOICEBOX_PRIMARY remains 0. Do not flip global primary.");
