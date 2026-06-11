#!/usr/bin/env node
/**
 * Apply src/db/supabase_rls_lockdown.sql to production Postgres.
 * Usage: node --import ./loadBackendEnv.mjs scripts/apply-supabase-rls.mjs [--dry-run]
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

const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db/supabase_rls_lockdown.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

if (dryRun) {
  console.log("Dry run — would execute supabase_rls_lockdown.sql (" + sql.length + " bytes)");
  console.log("Run without --dry-run to apply.");
  process.exit(0);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});
try {
  console.log("Applying RLS lockdown to", new URL(url).hostname, "…");
  await pool.query(sql);
  console.log("✓ RLS lockdown applied.\n");
  console.log("Next: node --import ./loadBackendEnv.mjs scripts/audit-supabase-rls.mjs");
  console.log("Then: npm run verify:storage && node scripts/test-production-readiness.mjs");
} catch (e) {
  console.error("Apply failed:", e?.message || e);
  process.exit(1);
} finally {
  await pool.end();
}
