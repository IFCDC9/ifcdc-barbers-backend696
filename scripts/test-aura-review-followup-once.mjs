#!/usr/bin/env node
/**
 * Controlled AURA Phase 2 review follow-up verification.
 * Sends only to the designated test sink; cancels disposable rows afterward.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_REVIEW_FOLLOWUP = "true";
process.env.AURA_PHASE2_TOOLS_ENABLED = "false";
process.env.AURA_DAILY_REPORT_PREVIEW = "false";
process.env.AURA_DAILY_REPORT_ENABLED = "false";

const { afterBookingCompleted } = require("../auraPhase2Hooks.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");
const { ensureAuraActionLogTable } = require("../auraActionLog.cjs");

const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
).trim();
const CUSTOMER_NAME = "AURA Phase 2 Review Followup Test";
const SERVICE = "Controlled review follow-up verification";
const marker = `controlled_review_followup_test_${Date.now()}`;

const flags = auraPhase2Flags();
if (!flags.reviewFollowup) {
  console.error(JSON.stringify({ ok: false, error: "local_reviewFollowup_off", flags }));
  process.exit(1);
}
if (flags.toolsEnabled || flags.dailyReportPreview || flags.dailyReportSend) {
  console.error(JSON.stringify({ ok: false, error: "unexpected_extra_flags_on", flags }));
  process.exit(1);
}

await ensureAuraActionLogTable(dbQuery);

function slotStrings(minutesAgo) {
  const startAt = new Date(Date.now() - minutesAgo * 60 * 1000);
  const yyyy = startAt.getUTCFullYear();
  const mm = String(startAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(startAt.getUTCDate()).padStart(2, "0");
  const hh = String(startAt.getUTCHours()).padStart(2, "0");
  const mi = String(startAt.getUTCMinutes()).padStart(2, "0");
  const ss = String(startAt.getUTCSeconds()).padStart(2, "0");
  return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: `${hh}:${mi}:${ss}` };
}

async function insertBooking(status, nameSuffix, minutesAgo) {
  const { dateStr, timeStr } = slotStrings(minutesAgo);
  const r = await dbQuery(
    `INSERT INTO bookings (
        customer_name, customer_email, barber_id, barber_name, service,
        date, time, amount, payment_status, booking_status, is_paid_booking,
        total_price, notes
      ) VALUES (
        $1, $2, $3::uuid, $4, $5,
        $6::date, $7::time, 35, 'paid', $8, true,
        35, $9
      )
      RETURNING id, booking_status, customer_name, customer_email, barber_name, service,
                date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
                total_price, review_prompt_sent_at`,
    [
      `${CUSTOMER_NAME} (${nameSuffix})`,
      CUSTOMER_EMAIL,
      BARBER_ID,
      BARBER_NAME,
      SERVICE,
      dateStr,
      timeStr,
      status,
      `AURA Phase 2 controlled review follow-up marker=${marker} role=${nameSuffix}`,
    ],
  );
  return r.rows?.[0];
}

const confirmedCountBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM bookings WHERE lower(coalesce(booking_status,'')) = 'confirmed'`,
);
const logsBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'review_followup'`,
);

const primary = await insertBooking("confirmed", "complete", 61);
const cancelled = await insertBooking("cancelled", "cancelled", 62);
const noShow = await insertBooking("no_show", "no_show", 63);
const incomplete = await insertBooking("confirmed", "incomplete", 64);

if (!primary?.id || !cancelled?.id || !noShow?.id || !incomplete?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }));
  process.exit(1);
}

// Mark primary completed (completion workflow equivalent for controlled Phase 2 path).
await dbQuery(
  `UPDATE bookings
   SET booking_status = 'completed',
       completed_at = COALESCE(completed_at, NOW()),
       completed_by = COALESCE(completed_by, 'aura_controlled_review_followup_test')
   WHERE id = $1::uuid`,
  [primary.id],
);

const first = await afterBookingCompleted(dbQuery, { id: primary.id, booking_status: "completed" });
await new Promise((r) => setTimeout(r, 500));
const second = await afterBookingCompleted(dbQuery, { id: primary.id, booking_status: "completed" });

const cancelledOut = await afterBookingCompleted(dbQuery, { id: cancelled.id });
const noShowOut = await afterBookingCompleted(dbQuery, { id: noShow.id });
const incompleteOut = await afterBookingCompleted(dbQuery, {
  id: incomplete.id,
  booking_status: "confirmed",
});

const primaryAfter = await dbQuery(
  `SELECT id, booking_status, customer_name, customer_email, barber_name, service,
          date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
          total_price, review_prompt_sent_at
   FROM bookings WHERE id = $1::uuid`,
  [primary.id],
);
const primaryRow = primaryAfter.rows?.[0];

const logsForPrimary = await dbQuery(
  `SELECT id, action, result, metadata, created_at
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'review_followup'
   ORDER BY created_at ASC`,
  [primary.id],
);

const logsSentTotal = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'review_followup'
     AND result = 'sent'
     AND created_at > NOW() - INTERVAL '10 minutes'
     AND booking_id = ANY($1::uuid[])`,
  [[primary.id, cancelled.id, noShow.id, incomplete.id]],
);

const unintended = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'review_followup'
     AND result = 'sent'
     AND created_at > NOW() - INTERVAL '10 minutes'
     AND booking_id IS DISTINCT FROM $1::uuid
     AND COALESCE(metadata->>'controlledTest', '') <> 'true'
     AND booking_id NOT IN (
       SELECT id FROM bookings
       WHERE COALESCE(notes, '') LIKE '%controlled_review_followup_test_%'
          OR COALESCE(notes, '') LIKE '%controlled_%_reminder_test_%'
          OR COALESCE(customer_name, '') LIKE 'AURA Phase 2%'
     )`,
  [primary.id],
);

const confirmedCountAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM bookings WHERE lower(coalesce(booking_status,'')) = 'confirmed'`,
);

// Cleanup disposable rows (cancel + mark notes)
for (const id of [primary.id, cancelled.id, noShow.id, incomplete.id]) {
  await dbQuery(
    `UPDATE bookings
     SET booking_status = 'cancelled',
         notes = COALESCE(notes, '') || ' | cleaned_after_controlled_review_followup_test'
     WHERE id = $1::uuid`,
    [id],
  );
}

const sentLogs = (logsForPrimary.rows || []).filter((r) => r.result === "sent");
const checks = {
  flagsReviewFollowup: flags.reviewFollowup === true,
  toolsStillOff: flags.toolsEnabled === false,
  dailyPreviewOff: flags.dailyReportPreview === false,
  dailySendOff: flags.dailyReportSend === false,
  firstSendOk: first?.ok === true && !first?.skipped,
  secondSkippedDuplicate: second?.skipped === "already_sent",
  cancelledSkipped: cancelledOut?.skipped === true && cancelledOut?.reason === "status_excluded",
  noShowSkipped: noShowOut?.skipped === true && noShowOut?.reason === "status_excluded",
  incompleteSkipped: incompleteOut?.skipped === true && incompleteOut?.reason === "not_completed",
  reviewPromptTimestampSet: Boolean(primaryRow?.review_prompt_sent_at),
  exactlyOneSentLog: sentLogs.length === 1,
  noExtraSentAmongTestIds: Number(logsSentTotal.rows?.[0]?.c || 0) === 1,
  noUnintendedRealCustomerSends: Number(unintended.rows?.[0]?.c || 0) === 0,
  emailSink: CUSTOMER_EMAIL.toLowerCase() === "service@ifcdc.org",
  detailsPresent: Boolean(
    primaryRow?.customer_name &&
      primaryRow?.barber_name &&
      primaryRow?.service &&
      primaryRow?.date &&
      primaryRow?.time_ampm,
  ),
};

const pass = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok: pass,
      verdict: pass ? "PASS" : "FAIL",
      feature: "AURA_PHASE2_REVIEW_FOLLOWUP",
      marker,
      customerEmail: CUSTOMER_EMAIL,
      bookingId: primary.id,
      cancelledId: cancelled.id,
      noShowId: noShow.id,
      incompleteId: incomplete.id,
      first,
      second,
      cancelledOut,
      noShowOut,
      incompleteOut,
      primaryRow,
      sentLog: sentLogs[0] || null,
      logsBefore: logsBefore.rows?.[0]?.c,
      confirmedCountBefore: confirmedCountBefore.rows?.[0]?.c,
      confirmedCountAfter: confirmedCountAfter.rows?.[0]?.c,
      checks,
      note: "Email content (Rate Me + rewards + appointment details) was sent via sendAuraReviewFollowupEmail to the test sink only.",
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
