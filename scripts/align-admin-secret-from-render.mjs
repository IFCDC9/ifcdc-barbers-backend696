#!/usr/bin/env node
/**
 * Align local ADMIN_SECRET (+ VITE_ADMIN_API_KEY) with the canonical production
 * Render service so /api/hubspot/verify and /test-contact accept x-admin-key.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/align-admin-secret-from-render.mjs
 *   RENDER_API_KEY=rnd_... node scripts/align-admin-secret-from-render.mjs --write
 *
 * Without --write: prints whether production ADMIN_SECRET is configured and
 * whether the local key matches (never prints secret values).
 * With --write: updates root .env ADMIN_SECRET and VITE_ADMIN_API_KEY to match
 * production (file is gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.render.com/v1";
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID || "srv-d6tmai24d50c73cdi0mg",
).trim();
const WRITE = process.argv.includes("--write");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const PROD = "https://ifcdc-barbers-backend696.onrender.com";

if (!TOKEN) {
  console.error(
    "Missing RENDER_API_KEY.\n" +
      "  RENDER_API_KEY=rnd_... node scripts/align-admin-secret-from-render.mjs --write\n" +
      "Manual alternative: copy ADMIN_SECRET from Render → ifcdc-barbers-backend696 → Environment\n" +
      "into local .env as both ADMIN_SECRET and VITE_ADMIN_API_KEY (must match).",
  );
  process.exit(1);
}

async function listEnvVars(serviceId) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${API}/services/${serviceId}/env-vars?${q}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${TOKEN}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`list env-vars → ${res.status}: ${text.slice(0, 300)}`);
    const json = text ? JSON.parse(text) : [];
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

function readLocalAdminSecret() {
  try {
    const text = fs.readFileSync(ENV_PATH, "utf8");
    const m = text.match(/^\s*ADMIN_SECRET\s*=\s*(.*)$/m);
    if (!m) return "";
    return String(m[1] || "").trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

function upsertEnvKey(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

const vars = await listEnvVars(SERVICE_ID);
const prodAdmin = vars.find((v) => v.key === "ADMIN_SECRET");
const localAdmin = readLocalAdminSecret();

console.log("\n=== ADMIN_SECRET alignment ===\n");
console.log("productionServiceId:", SERVICE_ID);
console.log("productionAdminSecretConfigured:", Boolean(prodAdmin?.value));
console.log("localAdminSecretConfigured:", Boolean(localAdmin));
console.log("lengthsMatch:", Boolean(prodAdmin?.value) && localAdmin.length === String(prodAdmin.value).length);
console.log("valuesMatch:", Boolean(prodAdmin?.value) && localAdmin === String(prodAdmin.value));

if (!prodAdmin?.value) {
  console.error(
    "\nFAIL  ADMIN_SECRET is not set on the canonical Render service.\n" +
      "Set it in Render Dashboard → ifcdc-barbers-backend696 → Environment,\n" +
      "then re-run this script with --write.",
  );
  process.exit(1);
}

if (!WRITE) {
  if (localAdmin === String(prodAdmin.value)) {
    console.log("\nLocal ADMIN_SECRET already matches production.");
  } else {
    console.log("\nLocal ADMIN_SECRET differs. Re-run with --write to update .env (gitignored).");
  }
} else {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  text = upsertEnvKey(text, "ADMIN_SECRET", String(prodAdmin.value));
  text = upsertEnvKey(text, "VITE_ADMIN_API_KEY", String(prodAdmin.value));
  fs.writeFileSync(ENV_PATH, text, "utf8");
  console.log("\nUpdated .env ADMIN_SECRET and VITE_ADMIN_API_KEY to match production (values not printed).");
}

// Live probe (never prints the key)
const probe = await fetch(`${PROD}/api/hubspot/verify`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-admin-key": WRITE ? String(prodAdmin.value) : localAdmin || String(prodAdmin.value),
  },
});
const body = await probe.json().catch(() => ({}));
console.log("\nproduction /api/hubspot/verify:", {
  http: probe.status,
  authenticated: body.authenticated ?? null,
  ok: body.ok ?? null,
});
console.log("");
process.exit(probe.status === 200 && body.authenticated ? 0 : 1);
