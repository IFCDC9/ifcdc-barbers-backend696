#!/usr/bin/env node
/**
 * Emergency: restore Render backend696 DATABASE_URL from Mac working .env
 * (or from an explicit DATABASE_URL env override), then restart via deploy.
 *
 * NEVER prints password values.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node scripts/restore-render-database-url.mjs
 *   RENDER_API_KEY=rnd_... DATABASE_URL='postgresql://...' node scripts/restore-render-database-url.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const SERVICE_ID = String(
  process.env.RENDER_BACKEND696_SERVICE_ID ||
    process.env.RENDER_SERVICE_ID ||
    "srv-d6tmai24d50c73cdi0mg",
).trim();
const TOKEN = String(process.env.RENDER_API_KEY || "").trim();
const LIVE = "https://ifcdc-barbers-backend696.onrender.com";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const map = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[t.slice(0, i).trim()] = v;
  }
  return map;
}

function fingerprint(url) {
  if (!url) return { present: false };
  const u = new URL(url);
  const pwd = decodeURIComponent(u.password || "");
  return {
    present: true,
    host: u.hostname,
    port: u.port || "(default)",
    user: u.username,
    db: u.pathname.replace(/^\//, ""),
    passwordLen: pwd.length,
    passwordEmpty: !pwd,
    hasPlaceholder: /YOUR-PASSWORD/i.test(url),
    hasSpaces: /\s/.test(url),
    specialChars: [...pwd].some((ch) => /[^A-Za-z0-9._~-]/.test(ch)),
    passwordLooksEncoded: /%/.test(u.password),
    sslmode: u.searchParams.get("sslmode"),
    urlHash8: crypto.createHash("sha256").update(url).digest("hex").slice(0, 8),
    pwdHash8: crypto.createHash("sha256").update(pwd).digest("hex").slice(0, 8),
  };
}

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
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
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function listEnvVars(serviceId) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    const page = await api(`/services/${serviceId}/env-vars?${q}`);
    const rows = Array.isArray(page) ? page : page?.items || [];
    for (const row of rows) {
      const ev = row?.envVar || row;
      if (ev?.key) out.push(ev);
    }
    cursor = page?.cursor;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

async function tryPg(url) {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { Client } = require("pg");
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  const client = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message).slice(0, 180) };
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

async function waitLiveBarbers(maxMs = 8 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const res = await fetch(`${LIVE}/api/app-bookings/barbers?channel=website`, {
        signal: AbortSignal.timeout(30000),
      });
      const json = await res.json().catch(() => ({}));
      const list = Array.isArray(json) ? json : json?.barbers || json?.data;
      if (res.ok && Array.isArray(list) && list.length > 0) {
        return { ok: true, count: list.length, names: list.map((b) => b.name || b.barber_name).slice(0, 5) };
      }
      console.log(`[live] barbers HTTP ${res.status} err=${json?.message || json?.error || "?"}`);
    } catch (e) {
      console.log(`[live] probe error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return { ok: false };
}

async function main() {
  if (!TOKEN) {
    console.error("Missing RENDER_API_KEY");
    process.exit(1);
  }

  const local = loadEnvFile(path.join(ROOT, ".env"));
  const candidate = String(process.env.DATABASE_URL || local.DATABASE_URL || "").trim();
  if (!candidate) {
    console.error("No DATABASE_URL in env or Mac .env");
    process.exit(1);
  }

  const fp = fingerprint(candidate);
  console.log("[mac/candidate]", JSON.stringify(fp));
  if (fp.hasPlaceholder || fp.passwordEmpty || fp.hasSpaces) {
    console.error("Candidate DATABASE_URL is invalid (placeholder/empty/spaces)");
    process.exit(1);
  }

  const localTest = await tryPg(candidate);
  console.log("[mac/candidate connect]", JSON.stringify(localTest));

  const vars = await listEnvVars(SERVICE_ID);
  const dbVars = vars.filter((v) => v.key === "DATABASE_URL");
  console.log("[render] DATABASE_URL count:", dbVars.length);
  const current = dbVars[0]?.value || "";
  console.log("[render current]", JSON.stringify(fingerprint(current)));
  console.log("[compare] sameUrl=", current === candidate);

  if (current && current !== candidate) {
    const renderTest = await tryPg(current);
    console.log("[render connect]", JSON.stringify(renderTest));
    if (!localTest.ok && renderTest.ok) {
      console.error(
        "Mac candidate cannot authenticate, but Render value can. NOT overwriting Render with a broken Mac URL.",
      );
      process.exit(2);
    }
  }

  if (!localTest.ok) {
    console.error(
      "Candidate DATABASE_URL cannot authenticate to Postgres. Refusing to push a known-bad password to Render.",
    );
    console.error(
      "Provide the current working DATABASE_URL from Supabase/Render dashboard via DATABASE_URL=... and re-run.",
    );
    process.exit(3);
  }

  console.log("[render] Updating DATABASE_URL from Mac candidate…");
  await api(`/services/${SERVICE_ID}/env-vars/DATABASE_URL`, {
    method: "PUT",
    body: { value: candidate },
  });

  console.log("[render] Triggering deploy/restart…");
  const deploy = await api(`/services/${SERVICE_ID}/deploys`, {
    method: "POST",
    body: { clearCache: "do_not_clear" },
  });
  console.log("[render] deploy id:", deploy?.id || deploy?.deploy?.id || "(unknown)");

  console.log("[live] Waiting for barbers API recovery…");
  const live = await waitLiveBarbers();
  console.log("[live]", JSON.stringify(live));
  if (!live.ok) process.exit(4);
  console.log("[ok] Production barbers API restored.");
}

main().catch((e) => {
  console.error("[fail]", e.message || e);
  process.exit(1);
});
