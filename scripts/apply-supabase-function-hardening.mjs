#!/usr/bin/env node
/**
 * Apply src/db/supabase_function_hardening.sql to production Postgres.
 * Usage: node --import ./loadBackendEnv.mjs scripts/apply-supabase-function-hardening.mjs [--dry-run]
 */
import "../loadBackendEnv.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");

function stripSslQueryFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return urlString;
  }
}

const url = stripSslQueryFromUrl(String(process.env.DATABASE_URL || "").trim());
if (!url) {
  console.error("DATABASE_URL missing.");
  process.exit(1);
}

const sqlPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/supabase_function_hardening.sql"
);
const sql = fs.readFileSync(sqlPath, "utf8");

if (dryRun) {
  console.log("Dry run — would execute supabase_function_hardening.sql (" + sql.length + " bytes)");
  process.exit(0);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});

try {
  console.log("Applying function hardening to", new URL(url).hostname, "…");
  await pool.query(sql);
  console.log("✓ Function hardening applied.");
  console.log("Next: node --import ./loadBackendEnv.mjs scripts/audit-supabase-security.mjs");
} catch (e) {
  console.error("Apply failed:", e?.message || e);
  process.exit(1);
} finally {
  await pool.end();
}
