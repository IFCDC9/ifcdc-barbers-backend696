#!/usr/bin/env node
/**
 * Mirror Supabase Security Advisor checks we can run via DATABASE_URL.
 * Usage: node --import ./loadBackendEnv.mjs scripts/audit-supabase-security.mjs
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
  console.error("DATABASE_URL missing.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const errors = [];
const warnings = [];
const suggestions = [];

try {
  // ---- RLS disabled (CRITICAL) ---------------------------------------------
  const rls = await pool.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  `);
  if (rls.rows.length) {
    errors.push(`RLS disabled on ${rls.rows.length} table(s): ${rls.rows.map((r) => r.relname).join(", ")}`);
  }

  // ---- Mutable search_path on custom plpgsql/sql functions -------------------
  const mutableFuncs = await pool.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND l.lanname IN ('plpgsql', 'sql')
      AND p.prokind = 'f'
      AND NOT COALESCE(
        (SELECT bool_or(c LIKE 'search_path=%') FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c),
        false
      )
    ORDER BY p.proname
  `);
  for (const r of mutableFuncs.rows) {
    warnings.push(
      `function_search_path_mutable: ${r.proname}(${r.args})${r.prosecdef ? " [SECURITY DEFINER]" : ""}`
    );
  }

  // ---- SECURITY DEFINER + anon EXECUTE (elevated risk) -----------------------
  const definerAnon = await pool.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ORDER BY p.proname
  `);
  for (const r of definerAnon.rows) {
    if (r.proname === "rls_auto_enable") continue;
    warnings.push(`security_definer_anon_execute: ${r.proname}(${r.args})`);
  }

  // ---- Extensions in public schema -----------------------------------------
  const extPublic = await pool.query(`
    SELECT e.extname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname = 'public'
  `);
  for (const r of extPublic.rows) {
    suggestions.push(`extension_in_public: ${r.extname} (move to extensions schema when convenient)`);
  }

  // ---- Storage RLS ---------------------------------------------------------
  const storageRls = await pool.query(`
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects'
  `);
  if (!storageRls.rows[0]?.relrowsecurity) {
    warnings.push("storage.objects RLS disabled");
  }
  const storagePolicies = await pool.query(`
    SELECT COUNT(*)::int AS n FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  `);
  if (storagePolicies.rows[0]?.n === 0) {
    suggestions.push("storage.objects has RLS but no policies — run src/db/supabase_rls_storage.sql in SQL Editor");
  }

  // ---- Dangerous public-role table policies ----------------------------------
  const publicPolicies = await pool.query(`
    SELECT tablename, policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public' AND 'public' = ANY(roles)
    ORDER BY tablename
  `);
  for (const r of publicPolicies.rows) {
    warnings.push(`policy_public_role: ${r.tablename}.${r.policyname} [${r.cmd}]`);
  }

  // ---- Report ----------------------------------------------------------------
  console.log("\n=== Supabase Security Audit (vtkxuagevtiwtoheomjt) ===\n");
  console.log(`Errors (critical):   ${errors.length}`);
  console.log(`Warnings:            ${warnings.length}`);
  console.log(`Suggestions:         ${suggestions.length}\n`);

  if (errors.length) {
    console.log("ERRORS:");
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log("");
  } else {
    console.log("✓ No critical RLS errors.\n");
  }

  if (warnings.length) {
    console.log("WARNINGS:");
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    console.log("");
  } else {
    console.log("✓ No security warnings detected.\n");
  }

  if (suggestions.length) {
    console.log("SUGGESTIONS (informational):");
    for (const s of suggestions) console.log(`  • ${s}`);
    console.log("");
  }

  // Custom function status
  const custom = await pool.query(`
    SELECT p.proname,
      COALESCE((SELECT bool_or(c LIKE 'search_path=%') FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c), false) AS pinned,
      p.prosecdef,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND l.lanname IN ('plpgsql', 'sql') AND p.prokind = 'f'
    ORDER BY p.proname
  `);
  console.log("Custom functions:");
  for (const r of custom.rows) {
    const flags = [
      r.pinned ? "search_path=OK" : "search_path=MUTABLE",
      r.prosecdef ? "SECURITY DEFINER" : "invoker",
      r.anon_exec ? "anon:EXECUTE" : "anon:blocked",
    ].join(" | ");
    console.log(`  ${r.proname}: ${flags}`);
  }

  process.exit(errors.length ? 1 : warnings.length ? 2 : 0);
} catch (e) {
  console.error("Audit failed:", e?.message || e);
  process.exit(3);
} finally {
  await pool.end();
}
