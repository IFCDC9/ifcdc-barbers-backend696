#!/usr/bin/env node
/**
 * Controlled AURA Phase 2 2h reminder verification.
 * Creates one test booking inside the 110–130 minute window, runs the scanner
 * safely, verifies idempotency, confirms 24h reminder is not resent, then cancels.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_REMINDERS_24H = "true";
process.env.AURA_PHASE2_REMINDERS_2H = "true";
process.env.AURA_PHASE2_REMINDERS_30M = "false";

const { scanAndSendBookingReminders2h } = await import("../bookingReminders.js");
const { sendAuraReminderEmail, shopLocation } = require("../auraPhase2Emails.cjs");
const { logAuraAction, ensureAuraReminderColumns } = require("../auraActionLog.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");

const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
).trim();
const CUSTOMER_NAME = "AURA Phase 2 2h Reminder Test";
const SERVICE = "Controlled 2h reminder verification";
const marker = `controlled_2h_reminder_test_${Date.now()}`;

const flags = auraPhase2Flags();
if (!flags.reminders2h) {
  console.error(JSON.stringify({ ok: false, error: "local_reminders2h_off", flags }));
  process.exit(1);
}

await ensureAuraReminderColumns(dbQuery);

// Center of 110–130 minute window (~2 hours).
const startAt = new Date(Date.now() + 120 * 60 * 1000);
const yyyy = startAt.getUTCFullYear();
const mm = String(startAt.getUTCMonth() + 1).padStart(2, "0");
const dd = String(startAt.getUTCDate()).padStart(2, "0");
const hh = String(startAt.getUTCHours()).padStart(2, "0");
const mi = String(startAt.getUTCMinutes()).padStart(2, "0");
const ss = String(startAt.getUTCSeconds()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;
const timeStr = `${hh}:${mi}:${ss}`;

async function listEligible2h() {
  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service,
            date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
            reminder_2h_sent_at, reminder_24h_sent_at
     FROM bookings
     WHERE reminder_2h_sent_at IS NULL
       AND COALESCE(booking_status, '') NOT IN ('cancelled', 'canceled', 'no_show')
       AND (date + time) > NOW()
       AND (date + time) - make_interval(mins => $1::int) <= NOW()
       AND (date + time) - make_interval(mins => $2::int) >= NOW()
     ORDER BY date, time
     LIMIT 50`,
    [130, 110],
  );
  return r.rows || [];
}

const beforeWindow = await listEligible2h();

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
              reminder_2h_sent_at, reminder_24h_sent_at, total_price`,
  [
    CUSTOMER_NAME,
    CUSTOMER_EMAIL,
    BARBER_ID,
    BARBER_NAME,
    SERVICE,
    dateStr,
    timeStr,
    `AURA Phase 2 controlled 2h reminder marker=${marker}`,
  ],
);

const booking = inserted.rows?.[0];
if (!booking?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }));
  process.exit(1);
}

const afterInsertWindow = await listEligible2h();
const othersInWindow = afterInsertWindow.filter((r) => String(r.id) !== String(booking.id));

let firstScan;
let mode;

if (othersInWindow.length === 0) {
  mode = "full_scanner_safe";
  firstScan = await scanAndSendBookingReminders2h();
} else {
  mode = "single_booking_only_others_present";
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
    "2h",
  );
  if (!out?.ok) {
    console.error(
      JSON.stringify({
        ok: false,
        error: out?.error || "send_failed",
        othersInWindow: othersInWindow.length,
      }),
    );
    process.exit(1);
  }
  await dbQuery(`UPDATE bookings SET reminder_2h_sent_at = NOW() WHERE id = $1::uuid`, [booking.id]);
  await logAuraAction(dbQuery, {
    action: "reminder_2h",
    bookingId: booking.id,
    result: "sent",
    metadata: { to: CUSTOMER_EMAIL, marker, controlledTest: true, mode },
  });
  firstScan = { sent: 1, checked: 1, window: "2h", mode };
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

const othersRecent2h = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM bookings
   WHERE id <> $1::uuid
     AND reminder_2h_sent_at IS NOT NULL
     AND reminder_2h_sent_at > NOW() - INTERVAL '15 minutes'
     AND COALESCE(notes, '') NOT LIKE $2`,
  [booking.id, "%controlled_2h_reminder_test_%"],
);

const logs2h = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_2h'
   ORDER BY created_at DESC`,
  [booking.id],
);

const logs24h = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_24h'
   ORDER BY created_at DESC`,
  [booking.id],
);

// Second 2h scan — must not duplicate.
let secondScan;
if (mode === "full_scanner_safe") {
  secondScan = await scanAndSendBookingReminders2h();
} else {
  const stillEligible = (await listEligible2h()).filter((r) => String(r.id) === String(booking.id));
  secondScan = {
    sent: 0,
    checked: stillEligible.length,
    window: "2h",
    mode: "idempotent_check_without_full_scan",
    testStillEligible: stillEligible.length > 0,
  };
  if (stillEligible.length > 0) {
    console.error(JSON.stringify({ ok: false, error: "test_booking_still_eligible_after_send" }));
    process.exit(1);
  }
}

// Confirm this ~2h booking is outside the 24h window (must not get a 24h reminder).
const eligible24hForTest = await dbQuery(
  `SELECT id
   FROM bookings
   WHERE id = $1::uuid
     AND reminder_24h_sent_at IS NULL
     AND COALESCE(booking_status, '') NOT IN ('cancelled', 'canceled', 'no_show')
     AND (date + time) > NOW()
     AND (date + time) - make_interval(mins => $2::int) <= NOW()
     AND (date + time) - make_interval(mins => $3::int) >= NOW()`,
  [booking.id, 25 * 60, 23 * 60],
);
const scan24h = {
  sent: 0,
  note: "full_24h_scanner_not_invoked_to_avoid_other_customers",
  testBookingEligibleFor24h: (eligible24hForTest.rows || []).length > 0,
};

const logs2hAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_2h'`,
  [booking.id],
);
const logs24hAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_24h'`,
  [booking.id],
);

await dbQuery(
  `UPDATE bookings
   SET booking_status = 'cancelled',
       cancelled_at = NOW(),
       cancellation_reason = $2
   WHERE id = $1::uuid`,
  [booking.id, `Controlled AURA Phase 2 2h reminder test cleanup (${marker})`],
);

const at = CUSTOMER_EMAIL.indexOf("@");
const pass =
  Boolean(testRow?.reminder_2h_sent_at) &&
  testRow?.reminder_24h_sent_at == null &&
  (logs2h.rows || []).length === 1 &&
  String(logs2h.rows?.[0]?.result || "") === "sent" &&
  Number(logs2hAfter.rows?.[0]?.c || 0) === 1 &&
  Number(logs24hAfter.rows?.[0]?.c || 0) === 0 &&
  Number(secondScan?.sent || 0) === 0 &&
  scan24h.testBookingEligibleFor24h === false &&
  Number(othersRecent2h.rows?.[0]?.c || 0) === 0;

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
      scan24hAgainstTestWindow: scan24h,
      reminder_2h_sent_at: testRow?.reminder_2h_sent_at || null,
      reminder_24h_still_null: testRow?.reminder_24h_sent_at == null,
      reminder_sent_at_untouched: testRow?.reminder_sent_at == null,
      reminder2hLogCount: (logs2h.rows || []).length,
      reminder2hLogs: logs2h.rows || [],
      reminder24hLogsForTestBooking: logs24h.rows || [],
      reminder2hLogCountAfterSecondScan: logs2hAfter.rows?.[0]?.c ?? null,
      reminder24hLogCountAfter24hScan: logs24hAfter.rows?.[0]?.c ?? null,
      unintendedRecent2hStamps: othersRecent2h.rows?.[0]?.c ?? null,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
