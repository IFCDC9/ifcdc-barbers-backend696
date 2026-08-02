#!/usr/bin/env node
/**
 * Controlled one-shot AURA Phase 2 admin-alert verification.
 * Prerequisites: production flags.adminAlerts === true (verified by caller).
 * Sends exactly one Super Admin alert and verifies one aura_action_logs row.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { alertSuperAdminFailure } = require("../auraPhase2Notify.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");

const marker = `controlled_admin_alert_test_${Date.now()}`;
const recipient = String(
  process.env.BOOKING_ADMIN_EMAIL || process.env.AURA_DAILY_REPORT_TO || "service@ifcdc.org",
).trim();

const before = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'admin_alert'
     AND metadata->>'kind' = $1`,
  [marker],
);

const flagsLocal = auraPhase2Flags();
const send = await alertSuperAdminFailure(dbQuery, marker, {
  note: "Single controlled Phase 2 admin-alert verification. No booking was changed.",
  singleShot: true,
});

// brief settle for write visibility
await new Promise((r) => setTimeout(r, 500));

const after = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE action = 'admin_alert'
     AND metadata->>'kind' = $1
   ORDER BY created_at DESC`,
  [marker],
);

const recentDupes = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'admin_alert'
     AND created_at > NOW() - INTERVAL '10 minutes'`,
);

console.log(
  JSON.stringify(
    {
      marker,
      recipientDomain: recipient.includes("@") ? recipient.split("@").pop() : null,
      recipientConfigured: Boolean(recipient.includes("@")),
      localFlagsHint: flagsLocal,
      beforeCountForMarker: before.rows?.[0]?.c ?? 0,
      sendOk: Boolean(send?.ok),
      sendError: send?.error || null,
      sendId: send?.id || null,
      matchingLogRows: (after.rows || []).length,
      matchingLogs: (after.rows || []).map((r) => ({
        id: r.id,
        created_at: r.created_at,
        result: r.result,
        kind: r.metadata?.kind || (typeof r.metadata === "string" ? null : r.metadata?.kind),
        metadata: r.metadata,
      })),
      adminAlertsLast10Min: recentDupes.rows?.[0]?.c ?? null,
    },
    null,
    2,
  ),
);

const pass =
  send?.ok === true &&
  (before.rows?.[0]?.c ?? 0) === 0 &&
  (after.rows || []).length === 1 &&
  String(after.rows?.[0]?.result || "") === "sent";

process.exit(pass ? 0 : 1);
