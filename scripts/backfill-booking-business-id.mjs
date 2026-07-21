#!/usr/bin/env node
/**
 * Backfill bookings.business_id from barbers.business_id (+ legacy tenant mapping).
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/backfill-booking-business-id.mjs
 *   node --import ./loadBackendEnv.mjs scripts/backfill-booking-business-id.mjs --apply
 */
import { dbQuery } from "../db.js";
import {
  clearDefaultShopBusinessIdCache,
  resolveDefaultShopBusinessId,
} from "../businessIdResolve.js";

const APPLY = process.argv.includes("--apply");

clearDefaultShopBusinessIdCache();
const defaultShopId = await resolveDefaultShopBusinessId();
if (defaultShopId == null) {
  console.error("Could not resolve default shop businesses.id (expected IFCDC Barbers).");
  process.exit(1);
}

const preview = await dbQuery(
  `SELECT
     COUNT(*) FILTER (WHERE b.business_id IS NULL)::int AS missing,
     COUNT(*) FILTER (
       WHERE b.business_id IS NULL
         AND br.id IS NOT NULL
         AND (
           br.business_id ~ '^[1-9][0-9]*$'
           OR lower(coalesce(br.business_id, '')) IN ('default', '0', '')
         )
     )::int AS backfillable_via_barber,
     COUNT(*) FILTER (WHERE b.business_id IS NULL AND br.id IS NULL)::int AS orphan_barber
   FROM bookings b
   LEFT JOIN barbers br ON br.id = b.barber_id`,
);

console.log("\n=== bookings.business_id backfill ===\n");
console.log("defaultShopBusinessId:", defaultShopId);
console.log("preview:", preview.rows?.[0]);

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to write.\n");
  process.exit(0);
}

const updated = await dbQuery(
  `UPDATE bookings b
   SET business_id = COALESCE(
     CASE
       WHEN br.business_id ~ '^[1-9][0-9]*$' THEN br.business_id::bigint
       WHEN lower(coalesce(br.business_id, '')) IN ('default', '0', '') THEN $1::bigint
       ELSE NULL
     END,
     b.business_id
   )
   FROM barbers br
   WHERE br.id = b.barber_id
     AND b.business_id IS NULL
     AND (
       br.business_id ~ '^[1-9][0-9]*$'
       OR lower(coalesce(br.business_id, '')) IN ('default', '0', '')
     )
   RETURNING b.id`,
  [defaultShopId],
);

const updatedByName = await dbQuery(
  `UPDATE bookings b
   SET business_id = COALESCE(
     CASE
       WHEN br.business_id ~ '^[1-9][0-9]*$' THEN br.business_id::bigint
       WHEN lower(coalesce(br.business_id, '')) IN ('default', '0', '') THEN $1::bigint
       ELSE NULL
     END,
     b.business_id
   )
   FROM barbers br
   WHERE b.business_id IS NULL
     AND nullif(trim(b.barber_name), '') IS NOT NULL
     AND lower(trim(b.barber_name)) = lower(trim(br.name))
   RETURNING b.id`,
  [defaultShopId],
);

const after = await dbQuery(
  `SELECT
     COUNT(*)::int AS total,
     COUNT(business_id)::int AS with_business_id
   FROM bookings`,
);

console.log("updatedRows:", updated.rowCount ?? updated.rows?.length ?? 0);
console.log("updatedByNameRows:", updatedByName.rowCount ?? updatedByName.rows?.length ?? 0);
console.log("after:", after.rows?.[0]);
console.log("\nDone.\n");
