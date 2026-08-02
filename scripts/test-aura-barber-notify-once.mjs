#!/usr/bin/env node
/**
 * Controlled one-shot AURA Phase 2 barber-notify verification.
 * Sends exactly one barber notification email and verifies one aura_action_logs row.
 *
 * Recipient priority:
 *   AURA_TEST_BARBER_EMAIL | TEST_BARBER_EMAIL | SMOKE_BARBER_EMAIL | BARBER_NOTIFY_TEST_EMAIL
 *   else BOOKING_ADMIN_EMAIL (approved Super Admin inbox) as designated test sink
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { sendAuraBarberEventEmail } = require("../auraPhase2Emails.cjs");
const { logAuraAction } = require("../auraActionLog.cjs");

function pickRecipient() {
  const keys = [
    "AURA_TEST_BARBER_EMAIL",
    "TEST_BARBER_EMAIL",
    "SMOKE_BARBER_EMAIL",
    "BARBER_NOTIFY_TEST_EMAIL",
    "BOOKING_ADMIN_EMAIL",
    "AURA_DAILY_REPORT_TO",
  ];
  for (const k of keys) {
    const v = String(process.env[k] || "").trim();
    if (v.includes("@")) return { email: v, source: k };
  }
  return { email: "service@ifcdc.org", source: "default" };
}

const marker = `controlled_barber_notify_test_${Date.now()}`;
const { email: to, source } = pickRecipient();
const at = to.indexOf("@");

const before = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'barber_notify_created'
     AND metadata->>'marker' = $1`,
  [marker],
);

const send = await sendAuraBarberEventEmail(
  {
    barberEmail: to,
    barberName: "Test Barber (controlled notify)",
    customerName: "AURA Phase 2 Test Customer",
    customerEmail: "aura-phase2-test@ifcdc.local",
    service: "Controlled barber-notify verification",
    date: "2026-08-10",
    time: "10:00 AM",
    price: 0,
    bookingId: marker,
  },
  "created",
);

await logAuraAction(dbQuery, {
  action: "barber_notify_created",
  result: send?.ok ? "sent" : "failed",
  metadata: {
    marker,
    eventType: "created",
    recipientSource: source,
    barberEmailDomain: at > 0 ? to.slice(at + 1) : null,
    error: send?.error || null,
    controlledTest: true,
  },
});

await new Promise((r) => setTimeout(r, 500));

const after = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE action = 'barber_notify_created'
     AND metadata->>'marker' = $1
   ORDER BY created_at DESC`,
  [marker],
);

const recent = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action LIKE 'barber_notify_%'
     AND created_at > NOW() - INTERVAL '10 minutes'`,
);

console.log(
  JSON.stringify(
    {
      marker,
      recipientSource: source,
      recipientDomain: at > 0 ? to.slice(at + 1) : null,
      recipientPreview: at > 1 ? `${to[0]}***@${to.slice(at + 1)}` : null,
      beforeCountForMarker: before.rows?.[0]?.c ?? 0,
      sendOk: Boolean(send?.ok),
      sendError: send?.error || null,
      matchingLogRows: (after.rows || []).length,
      matchingLogs: after.rows || [],
      barberNotifyActionsLast10Min: recent.rows?.[0]?.c ?? null,
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
