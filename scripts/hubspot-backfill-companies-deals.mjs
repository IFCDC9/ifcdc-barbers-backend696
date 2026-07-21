#!/usr/bin/env node
/**
 * Controlled HubSpot company + deal backfill (canonical production data only).
 * Dry-run by default. Uses existing enqueue helpers (feature flags still apply).
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/hubspot-backfill-companies-deals.mjs
 *   node --import ./loadBackendEnv.mjs scripts/hubspot-backfill-companies-deals.mjs --apply --limit=25
 *
 * Optional:
 *   --companies-only  --deals-only  --limit=N
 */
import { dbQuery } from "../db.js";
import {
  enqueueCompanySyncById,
  enqueueDealSyncById,
  isHubSpotCompanySyncEnabled,
  isHubSpotConfigured,
  isHubSpotDealSyncEnabled,
  isHubSpotSyncEnabled,
} from "../hubspotService.js";

const APPLY = process.argv.includes("--apply");
const COMPANIES_ONLY = process.argv.includes("--companies-only");
const DEALS_ONLY = process.argv.includes("--deals-only");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = Math.min(Math.max(Number(limitArg?.split("=")[1]) || 25, 1), 200);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log("\n=== HubSpot controlled backfill ===\n");
console.log(
  JSON.stringify(
    {
      apply: APPLY,
      limit: LIMIT,
      configured: isHubSpotConfigured(),
      syncEnabled: isHubSpotSyncEnabled(),
      companySyncEnabled: isHubSpotCompanySyncEnabled(),
      dealSyncEnabled: isHubSpotDealSyncEnabled(),
    },
    null,
    2,
  ),
);

if (!isHubSpotConfigured() || !isHubSpotSyncEnabled()) {
  console.error("\nHubSpot sync is not configured/enabled in this environment. Aborting.\n");
  process.exit(1);
}

const doCompanies = !DEALS_ONLY;
const doDeals = !COMPANIES_ONLY;

let companyCandidates = { rows: [] };
let dealCandidates = { rows: [] };

if (doCompanies && isHubSpotCompanySyncEnabled()) {
  companyCandidates = await dbQuery(
    `SELECT b.id
     FROM businesses b
     LEFT JOIN hubspot_sync_companies m ON m.business_id = b.id
     WHERE m.business_id IS NULL
        OR m.hubspot_company_id IS NULL
        OR m.last_sync_status IS DISTINCT FROM 'synced'
     ORDER BY b.id ASC
     LIMIT $1`,
    [LIMIT],
  );
}

if (doDeals && isHubSpotDealSyncEnabled()) {
  dealCandidates = await dbQuery(
    `SELECT b.id::text AS id
     FROM bookings b
     LEFT JOIN hubspot_sync_deals m ON m.booking_id = b.id
     WHERE (
       b.is_paid_booking = true
       OR lower(coalesce(b.payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'captured', 'deposit_paid')
       OR lower(coalesce(b.booking_status, '')) IN ('completed', 'cancelled', 'no_show', 'confirmed')
     )
       AND lower(coalesce(b.booking_status, '')) IS DISTINCT FROM 'pending_payment'
       AND (
         m.booking_id IS NULL
         OR m.hubspot_deal_id IS NULL
         OR m.last_sync_status IS DISTINCT FROM 'synced'
       )
     ORDER BY coalesce(b.completed_at, b.created_at) DESC NULLS LAST
     LIMIT $1`,
    [LIMIT],
  );
}

console.log("\ncompanyCandidates:", companyCandidates.rows.length);
console.log("dealCandidates:", dealCandidates.rows.length);

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to enqueue sync jobs.\n");
  process.exit(0);
}

let companiesQueued = 0;
for (const row of companyCandidates.rows) {
  enqueueCompanySyncById(row.id, { reason: "controlled_backfill" });
  companiesQueued += 1;
  await sleep(150);
}

let dealsQueued = 0;
for (const row of dealCandidates.rows) {
  enqueueDealSyncById(row.id, { reason: "controlled_backfill" });
  dealsQueued += 1;
  await sleep(150);
}

console.log("\nqueued:", { companiesQueued, dealsQueued });
console.log("Waiting briefly for async workers...");
await sleep(Math.min(5000, 200 + (companiesQueued + dealsQueued) * 200));

const maps = await dbQuery(
  `SELECT 'contacts' AS t, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE last_sync_status='synced')::int AS synced FROM hubspot_sync_contacts
   UNION ALL
   SELECT 'companies', COUNT(*)::int, COUNT(*) FILTER (WHERE last_sync_status='synced')::int FROM hubspot_sync_companies
   UNION ALL
   SELECT 'deals', COUNT(*)::int, COUNT(*) FILTER (WHERE last_sync_status='synced')::int FROM hubspot_sync_deals`,
);
console.log("mappings:", maps.rows);
console.log("\nDone.\n");
