#!/usr/bin/env node
/**
 * Controlled AURA Phase 2 24h reminder verification.
 * Creates one test booking inside the 23h–25h window, runs the scanner safely
 * (only if no other eligible bookings exist; otherwise sends for the test id only),
 * verifies idempotency on a second scan, then cancels the test booking.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_REMINDERS_24H = "true";
// Keep other reminder windows off for this controlled run.
process.env.AURA_PHASE2_REMINDERS_2H = "false";
process.env.AURA_PHASE2_REMINDERS_30M = "false";

const { scanAndSendBookingReminders24h } = await import("../bookingReminders.js");
const { sendAuraReminderEmail } = require("../auraPhase2Emails.cjs");
const { logAuraAction, ensureAuraReminderColumns } = require("../auraActionLog.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");
const { shopLocation } = require("../auraPhase2Emails.cjs");

const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
).trim();
const CUSTOMER_NAME = "AURA Phase 2 24h Reminder Test";
const SERVICE = "Controlled 24h reminder verification";
const marker = `controlled_24h_reminder_test_${Date.now()}`;

const flags = auraPhase2Flags();
if (!flags.reminders24h) {
  console.error(JSON.stringify({ ok: false, error: "local_reminders24h_off", flags }));
  process.exit(1);
}

await ensureAuraReminderColumns(dbQuery);

// Center of 23h–25h window.
const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
const yyyy = startAt.getUTCFullYear();
const mm = String(startAt.getUTCMonth() + 1).padStart(2, "0");
const dd = String(startAt.getUTCDate()).padStart(2, "0");
const hh = String(startAt.getUTCHours()).padStart(2, "0");
const mi = String(startAt.getUTCMinutes()).padStart(2, "0");
const ss = String(startAt.getUTCSeconds()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;
const timeStr = `${hh}:${mi}:${ss}`;

async function listEligible24h() {
  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service,
            date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
            reminder_24h_sent_at
     FROM bookings
     WHERE reminder_24h_sent_at IS NULL
       AND COALESCE(booking_status, '') NOT IN ('cancelled', 'canceled', 'no_show')
       AND (date + time) > NOW()
       AND (date + time) - make_interval(mins => $1::int) <= NOW()
       AND (date + time) - make_interval(mins => $2::int) >= NOW()
     ORDER BY date, time
     LIMIT 50`,
    [25 * 60, 23 * 60],
  );
  return r.rows || [];
}

const beforeWindow = await listEligible24h();

const inserted = await dbQuery(
  `INSERT INTO bookings (
      customer_name, customer_email, barber_id, barber_name, service,
      date, time, amount, payment_status, booking_status, is_paid_booking,
      total_price, notes
    ) VALUES (
      $1, $2, $3::uuid, $4, $5,
      $6::date, $7::time, 25, 'unpaid', 'confirmed', false,
      25, $8
    )
    RETURNING id, customer_name, customer_email, barber_name, service,
              date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
              reminder_24h_sent_at, total_price`,
  [
    CUSTOMER_NAME,
    CUSTOMER_EMAIL,
    BARBER_ID,
    BARBER_NAME,
    SERVICE,
    dateStr,
    timeStr,
    `AURA Phase 2 controlled 24h reminder marker=${marker}`,
  ],
);

const booking = inserted.rows?.[0];
if (!booking?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }));
  process.exit(1);
}

const afterInsertWindow = await listEligible24h();
const othersInWindow = afterInsertWindow.filter((r) => String(r.id) !== String(booking.id));

let firstScan;
let mode;

if (othersInWindow.length === 0) {
  mode = "full_scanner_safe";
  firstScan = await scanAndSendBookingReminders24h();
} else {
  mode = "single_booking_only_others_present";
  // Do NOT run full scanner — would email real customers.
  const out = await sendAuraReminderEmail(
    {
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      barberName: booking.barber_name,
      service: booking.service,
      date: booking.date,
      time: booking.time_ampm,
      price: booking.total_price,
      bookingId: booking.id,
      location: shopLocation(),
    },
    "24h",
  );
  if (!out?.ok) {
    console.error(JSON.stringify({ ok: false, error: out?.error || "send_failed", othersInWindow: othersInWindow.length }));
    process.exit(1);
  }
  await dbQuery(`UPDATE bookings SET reminder_24h_sent_at = NOW() WHERE id = $1::uuid`, [booking.id]);
  await logAuraAction(dbQuery, {
    action: "reminder_24h",
    bookingId: booking.id,
    result: "sent",
    metadata: { to: CUSTOMER_EMAIL, marker, controlledTest: true, mode },
  });
  firstScan = { sent: 1, checked: 1, window: "24h", mode };
}

await new Promise((r) => setTimeout(r, 400));

const rowAfter = await dbQuery(
  `SELECT id, customer_name, customer_email, barber_name, service,
          date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
          reminder_24h_sent_at, reminder_2h_sent_at, reminder_sent_at
   FROM bookings WHERE id = $1::uuid`,
  [booking.id],
);
const testRow = rowAfter.rows?.[0];

const othersStillNull = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM bookings
   WHERE id <> $1::uuid
     AND reminder_24h_sent_at IS NOT NULL
     AND reminder_24h_sent_at > NOW() - INTERVAL '15 minutes'
     AND COALESCE(notes, '') NOT LIKE $2`,
  [booking.id, "%controlled_24h_reminder_test_%"],
);

const logs = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_24h'
   ORDER BY created_at DESC`,
  [booking.id],
);

// Second scan — must not send again.
let secondScan;
if (mode === "full_scanner_safe") {
  secondScan = await scanAndSendBookingReminders24h();
} else {
  const stillEligible = (await listEligible24h()).filter((r) => String(r.id) === String(booking.id));
  secondScan = {
    sent: 0,
    checked: stillEligible.length,
    window: "24h",
    mode: "idempotent_check_without_full_scan",
    testStillEligible: stillEligible.length > 0,
  };
  if (stillEligible.length > 0) {
    console.error(JSON.stringify({ ok: false, error: "test_booking_still_eligible_after_send" }));
    process.exit(1);
  }
}

const logsAfterSecond = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_24h'`,
  [booking.id],
);

const stillSentAt = await dbQuery(
  `SELECT reminder_24h_sent_at IS NOT NULL AS sent
   FROM bookings WHERE id = $1::uuid`,
  [booking.id],
);

// Cleanup — cancel test booking so it cannot occupy a live slot.
await dbQuery(
  `UPDATE bookings
   SET booking_status = 'cancelled',
       cancelled_at = NOW(),
       cancellation_reason = $2
   WHERE id = $1::uuid`,
  [booking.id, `Controlled AURA Phase 2 24h reminder test cleanup (${marker})`],
);

const at = CUSTOMER_EMAIL.indexOf("@");
const pass =
  Boolean(testRow?.reminder_24h_sent_at) &&
  (logs.rows || []).length === 1 &&
  String(logs.rows?.[0]?.result || "") === "sent" &&
  Number(logsAfterSecond.rows?.[0]?.c || 0) === 1 &&
  Number(secondScan?.sent || 0) === 0 &&
  Number(othersStillNull.rows?.[0]?.c || 0) === 0;

console.log(
  JSON.stringify(
    {
      ok: pass,
      marker,
      mode,
      flags,
      bookingId: booking.id,
      appointmentUtc: `${dateStr} ${timeStr}`,
      appointmentLocalLabel: testRow?.time_ampm || booking.time_ampm,
      recipientDomain: at > 0 ? CUSTOMER_EMAIL.slice(at + 1) : null,
      recipientPreview: at > 1 ? `${CUSTOMER_EMAIL[0]}***@${CUSTOMER_EMAIL.slice(at + 1)}` : null,
      emailFields: {
        customerName: CUSTOMER_NAME,
        barberName: BARBER_NAME,
        service: SERVICE,
        date: testRow?.date || booking.date,
        time: testRow?.time_ampm || booking.time_ampm,
        location: shopLocation(),
        bookingReference: booking.id,
      },
      eligibleBeforeInsert: beforeWindow.length,
      eligibleAfterInsert: afterInsertWindow.length,
      otherEligibleInWindow: othersInWindow.map((r) => ({
        id: r.id,
        emailDomain: String(r.customer_email || "").includes("@")
          ? String(r.customer_email).split("@")[1]
          : null,
      })),
      firstScan,
      secondScan,
      reminder_24h_sent_at: testRow?.reminder_24h_sent_at || null,
      reminder_2h_still_null: testRow?.reminder_2h_sent_at == null,
      reminder_sent_at_untouched: testRow?.reminder_sent_at == null,
      reminder24hLogCount: (logs.rows || []).length,
      reminder24hLogs: logs.rows || [],
      reminder24hLogCountAfterSecondScan: logsAfterSecond.rows?.[0]?.c ?? null,
      unintendedRecentReminderStamps: othersStillNull.rows?.[0]?.c ?? null,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
