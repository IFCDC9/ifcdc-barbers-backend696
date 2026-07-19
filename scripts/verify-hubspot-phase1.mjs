#!/usr/bin/env node
/**
 * Phase 1 HubSpot live verification.
 *
 * Uses HUBSPOT_SERVICE_KEY from the environment (never prints the key).
 * Optional:
 *   HUBSPOT_SYNC_ENABLED=1
 *   HUBSPOT_TEST_EMAIL=you@example.com
 *   HUBSPOT_TEST_NAME="IFCDC Phase1 Test"
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/verify-hubspot-phase1.mjs
 *   # or against production after deploy:
 *   curl -sS https://ifcdc-barbers-backend696.onrender.com/api/hubspot/health
 */
import {
  getHubSpotHealth,
  isHubSpotConfigured,
  isHubSpotSyncEnabled,
  syncContactToHubSpot,
  verifyHubSpotAuthentication,
} from "../hubspotService.js";

function redact(value) {
  const text = String(value ?? "");
  const key = String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
  if (!key) return text;
  return text.split(key).join("[redacted]");
}

console.log("\n=== HubSpot Phase 1 verification ===\n");
console.log("configured:", isHubSpotConfigured() ? "yes" : "no");
console.log("HUBSPOT_SYNC_ENABLED:", isHubSpotSyncEnabled() ? "on" : "off");
console.log("serviceKey:", isHubSpotConfigured() ? "configured" : "missing");

if (!isHubSpotConfigured()) {
  console.error("FAIL  HUBSPOT_SERVICE_KEY is not available in this process environment.");
  process.exit(1);
}

const auth = await verifyHubSpotAuthentication();
console.log("auth:", auth.ok ? "OK" : "FAIL", redact(auth.message));
if (auth.portalId) console.log("portalId:", auth.portalId);
if (!auth.ok) process.exit(1);

const health = await getHubSpotHealth();
console.log("health:", health.ok ? "OK" : "FAIL", {
  configured: health.configured,
  syncEnabled: health.syncEnabled,
  authenticated: health.authenticated,
  serviceKey: health.serviceKey,
});

const testEmail = String(process.env.HUBSPOT_TEST_EMAIL || "hubspot.phase1+ifcdc@example.com")
  .trim()
  .toLowerCase();
const testName = String(process.env.HUBSPOT_TEST_NAME || "IFCDC Phase1 Test").trim();

if (!isHubSpotSyncEnabled()) {
  console.log("WARN  HUBSPOT_SYNC_ENABLED is off — enabling temporarily for contact sync test only in-process.");
  process.env.HUBSPOT_SYNC_ENABLED = "1";
}

const sync = await syncContactToHubSpot(
  {
    id: null,
    email: testEmail,
    name: testName,
    phone: "",
    role: "user",
  },
  { reason: "phase1_verify_script" },
);

console.log("contact sync:", sync.ok ? "OK" : "FAIL", {
  action: sync.action || sync.reason || null,
  hubspotContactId: sync.hubspotContactId || null,
  message: sync.message ? redact(sync.message) : undefined,
});

if (!sync.ok) process.exit(1);

// Idempotent update path
const syncAgain = await syncContactToHubSpot(
  {
    id: null,
    email: testEmail,
    name: `${testName} Updated`,
    phone: "",
    role: "user",
  },
  { reason: "phase1_verify_update" },
);
console.log("contact update:", syncAgain.ok ? "OK" : "FAIL", {
  action: syncAgain.action || syncAgain.reason || null,
});

if (!syncAgain.ok) process.exit(1);

console.log("\nAll HubSpot Phase 1 checks passed.\n");
