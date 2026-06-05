#!/usr/bin/env node
/**
 * Final production cleanup verification — canonical domain, storage, no demo routing.
 * Usage: node scripts/verify-production-cleanup.mjs
 */
const BACKEND = "https://ifcdc-barbers-backend696.onrender.com";
const CANONICAL = "https://ifcdcbarbersapp.com";
const EXPECTED_COMMIT_SHORT = "561601e2";

let failed = 0;
function pass(label, ok, detail = "") {
  const mark = ok ? "OK" : "FAIL";
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { res, data };
}

console.log("\n=== IFCDC production cleanup verification ===\n");

const deploy = await fetchJson(`${BACKEND}/api/deploy-info`);
pass("Backend deploy-info reachable", deploy.res.ok, `HTTP ${deploy.res.status}`);

const liveShort = String(deploy.data?.activeCommitShort || "").slice(0, 8);
pass(
  `Backend running commit ${EXPECTED_COMMIT_SHORT}`,
  liveShort === EXPECTED_COMMIT_SHORT,
  liveShort ? `live=${liveShort} (deploy may still be in progress)` : "unknown",
);

const web = deploy.data?.publicWeb || {};
pass(
  "FRONTEND_URL uses ifcdcbarbersapp.com",
  String(web.frontendUrlEnv || "").includes("ifcdcbarbersapp.com"),
  web.frontendUrlEnv || "(unset on server)",
);
pass(
  "Resolved public origin is canonical",
  web.usesCanonicalDomain === true,
  web.resolvedOrigin || "",
);
pass(
  "Invite links use canonical domain",
  String(web.inviteExample || "").startsWith(CANONICAL),
  web.inviteExample,
);
pass(
  "Privacy URL canonical",
  String(web.privacyUrl || "").startsWith(`${CANONICAL}/privacy`),
  web.privacyUrl,
);
pass(
  "Terms URL canonical",
  String(web.termsUrl || "").startsWith(`${CANONICAL}/terms`),
  web.termsUrl,
);

const storage = deploy.data?.persistentStorage || {};
pass(
  "Supabase persistent storage configured",
  storage.supabaseConfigured === true,
  storage.supabaseConfigured
    ? `bucket=${storage.bucket}`
    : "Add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Render → backend696 → Environment, then redeploy",
);

for (const path of ["/", "/privacy", "/terms"]) {
  const r = await fetch(`${CANONICAL}${path}`);
  const html = await r.text();
  const spa = /id="root"/i.test(html) && !/lander|godaddy/i.test(html);
  pass(`SPA ${path}`, r.ok && spa, `HTTP ${r.status}`);
}

const barbers = await fetchJson(`${BACKEND}/api/app-bookings/barbers`);
const list = Array.isArray(barbers.data) ? barbers.data : barbers.data?.barbers;
const names = (list || []).map((b) => String(b?.name || "").toLowerCase());
pass(
  "No demo barbers in public API list",
  !names.includes("fade master") && !names.includes("clipper king"),
  names.length ? `${names.length} barber(s)` : "empty list (add real barbers in Admin)",
);

const demoPhotos = (list || []).filter((b) =>
  String(b?.photo || b?.image || "").includes("/uploads/sample"),
);
pass("No ephemeral /uploads/sample photos in API", demoPhotos.length === 0);

console.log("");
if (failed) {
  console.log(`${failed} check(s) failed. Update Render env (FRONTEND_URL) and redeploy backend696.\n`);
  process.exit(1);
}
console.log("All production cleanup checks passed.\n");
