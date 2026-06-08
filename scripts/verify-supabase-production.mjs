#!/usr/bin/env node
/**
 * Verify production Supabase Storage is reachable (no secrets printed).
 * Usage: node scripts/verify-supabase-production.mjs [--base URL]
 */
const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/+$/, "");

console.log(`\nSupabase storage check → ${base}\n`);

const deploy = await fetch(`${base}/api/deploy-info`).then((r) => r.json()).catch(() => ({}));
const health = await fetch(`${base}/api/storage-health`).then(async (r) => ({
  status: r.status,
  body: await r.json(),
})).catch((e) => ({ status: 0, body: { error: e?.message } }));

const ps = deploy?.persistentStorage || {};
console.log("Deploy commit:", deploy?.activeCommitShort || deploy?.activeCommit || "?");
console.log("Storage (deploy-info):");
console.log("  supabaseConfigured:", ps.supabaseConfigured);
console.log("  envOnlyConfigured:", ps.envOnlyConfigured);
console.log("  clientReady:", ps.clientReady);
console.log("  storageReachable:", ps.storageReachable);
console.log("  bucket:", ps.bucket);
console.log("  urlHost:", ps.urlHost);
if (ps.lastError) console.log("  lastError:", ps.lastError);

console.log("\nStorage health:", health.status, health.body?.ok ? "OK" : "FAIL");
if (health.body?.message) console.log("  message:", health.body.message);
if (health.body?.probe?.reason) console.log("  probe:", health.body.probe.reason);

const ok = Boolean(ps.supabaseConfigured && health.body?.ok);
console.log(ok ? "\n✓ Production photo storage is ready.\n" : "\n✗ Production photo storage is NOT ready — fix Render env vars and redeploy.\n");
process.exit(ok ? 0 : 1);
