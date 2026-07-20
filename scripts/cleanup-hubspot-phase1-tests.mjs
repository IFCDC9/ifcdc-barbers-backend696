#!/usr/bin/env node
/**
 * Remove Phase 1 HubSpot verification users/contacts from production.
 *
 * Prefers the live admin cleanup endpoint (uses production HUBSPOT_SERVICE_KEY).
 * Falls back to direct DB cleanup when the endpoint is unavailable.
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/cleanup-hubspot-phase1-tests.mjs
 *   IFCDC_DRY_RUN=1 node --import ./loadBackendEnv.mjs scripts/cleanup-hubspot-phase1-tests.mjs
 */
import crypto from "node:crypto";
import { dbQuery } from "../db.js";
import { hashPassword } from "../authPasswordPolicy.js";
import { cleanupPhase1TestArtifacts } from "../hubspotService.js";

const BASE = String(
  process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com",
).replace(/\/+$/, "");
const dryRun = String(process.env.IFCDC_DRY_RUN || "").trim() === "1";
const CLEANUP_EMAIL = "phase1.cleanup.ops@ifcdcbarbersapp.com";

const SELECT_SQL = `
  SELECT id, email, name, role
  FROM app_users
  WHERE lower(email) LIKE 'phase1.%@%'
     OR lower(email) LIKE 'hubspot.phase1%@%'
     OR name ILIKE 'Phase1 Register%'
     OR name ILIKE 'IFCDC Phase1%'
     OR name ILIKE 'IFCDC HubSpot Phase1%'
     OR name ILIKE 'HubSpot Phase1%'
  ORDER BY created_at DESC
`;

function redact(email) {
  return String(email || "").replace(/^(.{3}).+(@.+)$/, "$1***$2");
}

console.log(dryRun ? "\n[DRY RUN] Phase 1 HubSpot test cleanup\n" : "\nPhase 1 HubSpot test cleanup\n");

const found = await dbQuery(SELECT_SQL);
console.log(`Matching app_users: ${found.rows?.length || 0}`);
for (const row of found.rows || []) {
  console.log(`  ${redact(row.email)} role=${row.role} name=${row.name}`);
}

const maps = await dbQuery(
  `SELECT email, hubspot_contact_id IS NOT NULL AS has_id
   FROM hubspot_sync_contacts
   WHERE lower(email) LIKE 'phase1.%@%' OR lower(email) LIKE 'hubspot.phase1%@%'`,
);
console.log(`Matching hubspot_sync_contacts: ${maps.rows?.length || 0}`);

if (dryRun) {
  console.log("\nRe-run without IFCDC_DRY_RUN=1 to delete.\n");
  process.exit(0);
}

async function tryAdminEndpointCleanup() {
  const password = `P1Clean!${crypto.randomBytes(6).toString("base64url")}`;
  const passwordHash = await hashPassword(password);

  const existing = await dbQuery(
    `SELECT id FROM app_users WHERE lower(trim(email::text)) = lower(trim($1)) LIMIT 1`,
    [CLEANUP_EMAIL],
  );
  if (existing.rows?.[0]?.id) {
    await dbQuery(
      `UPDATE app_users
       SET password_hash = $2, role = 'admin', account_status = 'active', name = 'Phase1 Cleanup Ops'
       WHERE id = $1::uuid`,
      [existing.rows[0].id, passwordHash],
    );
  } else {
    await dbQuery(
      `INSERT INTO app_users (name, email, password_hash, role, account_status)
       VALUES ('Phase1 Cleanup Ops', $1, $2, 'admin', 'active')`,
      [CLEANUP_EMAIL, passwordHash],
    );
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: CLEANUP_EMAIL, password }),
  });
  const loginJson = await login.json().catch(() => ({}));
  if (!login.ok || !loginJson.token) {
    console.warn("Admin login for cleanup endpoint failed:", login.status, loginJson.error || loginJson.message);
    await dbQuery(`DELETE FROM app_users WHERE lower(email) = lower($1)`, [CLEANUP_EMAIL]).catch(() => {});
    return null;
  }

  const cleanup = await fetch(`${BASE}/api/hubspot/cleanup-phase1-tests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginJson.token}`,
    },
  });
  const cleanupJson = await cleanup.json().catch(() => ({}));
  console.log("Admin cleanup endpoint:", cleanup.status, {
    ok: cleanupJson.ok,
    hubspotDeleted: cleanupJson.hubspotDeleted,
    usersDeleted: cleanupJson.usersDeleted,
    mappingsDeleted: cleanupJson.mappingsDeleted,
  });

  // Remove the temporary cleanup operator account
  await dbQuery(`DELETE FROM app_users WHERE lower(email) = lower($1)`, [CLEANUP_EMAIL]).catch(() => {});

  return cleanup.ok ? cleanupJson : null;
}

let result = await tryAdminEndpointCleanup();
if (!result) {
  console.log("Falling back to direct DB + HubSpot cleanup via local process env...");
  result = await cleanupPhase1TestArtifacts({ deleteAppUsers: true });
  console.log("Direct cleanup:", {
    ok: result.ok,
    hubspotDeleted: result.hubspotDeleted,
    usersDeleted: result.usersDeleted,
    mappingsDeleted: result.mappingsDeleted,
  });
}

const remaining = await dbQuery(SELECT_SQL);
console.log(`\nRemaining matching users: ${remaining.rows?.length || 0}`);
if ((remaining.rows?.length || 0) > 0) {
  for (const row of remaining.rows || []) console.log(`  still: ${redact(row.email)}`);
  process.exit(1);
}
console.log("\nPhase 1 test artifacts removed.\n");
