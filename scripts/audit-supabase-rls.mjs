#!/usr/bin/env node
/**
 * Audit public tables for missing RLS (Supabase rls_disabled_in_public).
 * Usage: node --import ./loadBackendEnv.mjs scripts/audit-supabase-rls.mjs
 */
import "../loadBackendEnv.mjs";
import pg from "pg";

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
  console.error("DATABASE_URL missing — set in .env to audit production.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

try {
  const tables = await pool.query(`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const policies = await pool.query(`
    SELECT tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);

  const withoutRls = tables.rows.filter((r) => !r.rls_enabled);
  const withRlsNoPolicy = tables.rows.filter((r) => {
    if (!r.rls_enabled) return false;
    return !policies.rows.some((p) => p.tablename === r.table_name);
  });

  console.log("\n=== Supabase RLS audit (public schema) ===\n");
  console.log(`Tables: ${tables.rows.length}`);
  console.log(`RLS enabled: ${tables.rows.filter((r) => r.rls_enabled).length}`);
  console.log(`RLS DISABLED (CRITICAL): ${withoutRls.length}\n`);

  if (withoutRls.length) {
    console.log("Tables without RLS:");
    for (const r of withoutRls) console.log(`  ✗ ${r.table_name}`);
    console.log("");
  } else {
    console.log("✓ All public tables have RLS enabled.\n");
  }

  if (withRlsNoPolicy.length) {
    console.log("Backend-only tables (RLS on, no client policies — expected):");
    for (const r of withRlsNoPolicy) console.log(`  • ${r.table_name}`);
    console.log("");
  }

  console.log("Client-accessible policies:");
  for (const p of policies.rows) {
    console.log(`  ${p.tablename}.${p.policyname} [${p.cmd}] roles=${JSON.stringify(p.roles)}`);
  }

  const storageRls = await pool.query(`
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects'
  `);
  const storagePolicies = await pool.query(`
    SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
  `);
  console.log("\nStorage.objects RLS:", storageRls.rows[0]?.relrowsecurity ? "enabled" : "DISABLED");
  console.log("Storage policies:", storagePolicies.rows.map((p) => p.policyname).join(", ") || "(none)");

  process.exit(withoutRls.length ? 1 : 0);
} catch (e) {
  console.error("Audit failed:", e?.message || e);
  process.exit(2);
} finally {
  await pool.end();
}
