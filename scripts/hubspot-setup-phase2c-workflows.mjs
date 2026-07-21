#!/usr/bin/env node
/**
 * Phase 2C HubSpot setup CLI (uses HUBSPOT_SERVICE_KEY from env; never prints it).
 *
 *   node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs
 *   node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs --apply
 *   node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs --apply --enable
 */
import {
  ensurePhase2cHubSpotSetup,
} from "../hubspotPhase2cSetupService.js";

const APPLY = process.argv.includes("--apply");
const ENABLE = process.argv.includes("--enable");

if (!String(process.env.HUBSPOT_SERVICE_KEY || "").trim()) {
  console.error(
    "Missing HUBSPOT_SERVICE_KEY.\n" +
      "On canonical Render this runs automatically at boot.\n" +
      "Locally, copy the key from Render into your shell env (do not paste into chat).",
  );
  process.exit(1);
}

if (!APPLY) {
  console.log("\nDry-run mode: use --apply to create/update HubSpot objects.\n");
  console.log("Tip: production boot already runs ensurePhase2cHubSpotSetup automatically.\n");
  process.exit(0);
}

const summary = await ensurePhase2cHubSpotSetup({ enableWorkflows: ENABLE || true });
console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      ranAt: summary.ranAt,
      portalId: summary.portalId || null,
      properties: summary.properties,
      emails: (summary.emails || []).map((e) => ({
        name: e.name,
        status: e.status,
        hasId: Boolean(e.id),
        state: e.state || null,
        http: e.http || null,
        message: e.message || null,
      })),
      workflows: summary.workflows,
      notes: summary.notes,
    },
    null,
    2,
  ),
);
process.exit(summary.ok ? 0 : 2);
