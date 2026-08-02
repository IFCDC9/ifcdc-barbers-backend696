#!/usr/bin/env node
/**
 * Controlled AURA Phase 2 30m reminder verification.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_REMINDERS_24H = "true";
process.env.AURA_PHASE2_REMINDERS_2H = "true";
process.env.AURA_PHASE2_REMINDERS_30M = "true";

const { scanAndSendBookingReminders } = await import("../bookingReminders.js");
const { sendAuraReminderEmail, shopLocation } = require("../auraPhase2Emails.cjs");
const { logAuraAction, ensureAuraReminderColumns } = require("../auraActionLog.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");

const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
).trim();
const CUSTOMER_NAME = "AURA Phase 2 30m Reminder Test";
const SERVICE = "Controlled 30m reminder verification";
const marker = `controlled_30m_reminder_test_${Date.now()}`;

const flags = auraPhase2Flags();
if (!flags.reminders30m) {
  console.error(JSON.stringify({ ok: false, error: "local_reminders30m_off", flags }));
  process.exit(1);
}

await ensureAuraReminderColumns(dbQuery);

// Center of 28–32 minute window.
const startAt = new Date(Date.now() + 30 * 60 * 1000);
const yyyy = startAt.getUTCFullYear();
const mm = String(startAt.getUTCMonth() + 1).padStart(2, "0");
const dd = String(startAt.getUTCDate()).padStart(2, "0");
const hh = String(startAt.getUTCHours()).padStart(2, "0");
const mi = String(startAt.getUTCMinutes()).padStart(2, "0");
const ss = String(startAt.getUTCSeconds()).padStart(2, "0");
const dateStr = `${yyyy}-${mm}-${dd}`;
const timeStr = `${hh}:${mi}:${ss}`;

async function listEligible30m() {
  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service,
            date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
            reminder_sent_at, reminder_24h_sent_at, reminder_2h_sent_at
     FROM bookings
     WHERE reminder_sent_at IS NULL
       AND COALESCE(booking_status, '') NOT IN ('cancelled', 'canceled', 'no_show')
       AND (date + time) > NOW()
       AND (date + time) - make_interval(mins => $1::int) <= NOW()
       AND (date + time) - make_interval(mins => $2::int) >= NOW()
     ORDER BY date, time
     LIMIT 50`,
    [32, 28],
  );
  return r.rows || [];
}

const beforeWindow = await listEligible30m();

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
              reminder_sent_at, reminder_24h_sent_at, reminder_2h_sent_at, total_price`,
  [
    CUSTOMER_NAME,
    CUSTOMER_EMAIL,
    BARBER_ID,
    BARBER_NAME,
    SERVICE,
    dateStr,
    timeStr,
    `AURA Phase 2 controlled 30m reminder marker=${marker}`,
  ],
);

const booking = inserted.rows?.[0];
if (!booking?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }));
  process.exit(1);
}

const afterInsertWindow = await listEligible30m();
const othersInWindow = afterInsertWindow.filter((r) => String(r.id) !== String(booking.id));

let firstScan;
let mode;

if (othersInWindow.length === 0) {
  mode = "full_scanner_safe";
  firstScan = await scanAndSendBookingReminders();
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
    "30m",
  );
  if (!out?.ok) {
    console.error(JSON.stringify({ ok: false, error: out?.error || "send_failed", others: othersInWindow.length }));
    process.exit(1);
  }
  await dbQuery(`UPDATE bookings SET reminder_sent_at = NOW() WHERE id = $1::uuid`, [booking.id]);
  await logAuraAction(dbQuery, {
    action: "reminder_30m",
    bookingId: booking.id,
    result: "sent",
    metadata: { to: CUSTOMER_EMAIL, marker, controlledTest: true, mode },
  });
  firstScan = { sent: 1, checked: 1, window: "30m", mode };
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

const othersRecent30m = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM bookings
   WHERE id <> $1::uuid
     AND reminder_sent_at IS NOT NULL
     AND reminder_sent_at > NOW() - INTERVAL '15 minutes'
     AND COALESCE(notes, '') NOT LIKE $2`,
  [booking.id, "%controlled_30m_reminder_test_%"],
);

const logs30m = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'reminder_30m'
   ORDER BY created_at DESC`,
  [booking.id],
);

let secondScan;
if (mode === "full_scanner_safe") {
  secondScan = await scanAndSendBookingReminders();
} else {
  const stillEligible = (await listEligible30m()).filter((r) => String(r.id) === String(booking.id));
  secondScan = {
    sent: 0,
    checked: stillEligible.length,
    window: "30m",
    mode: "idempotent_check_without_full_scan",
    testStillEligible: stillEligible.length > 0,
  };
  if (stillEligible.length > 0) {
    console.error(JSON.stringify({ ok: false, error: "test_booking_still_eligible_after_send" }));
    process.exit(1);
  }
}

const eligible24h = await dbQuery(
  `SELECT id FROM bookings WHERE id = $1::uuid AND reminder_24h_sent_at IS NULL
     AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled','no_show')
     AND (date + time) > NOW()
     AND (date + time) - make_interval(mins => $2::int) <= NOW()
     AND (date + time) - make_interval(mins => $3::int) >= NOW()`,
  [booking.id, 25 * 60, 23 * 60],
);
const eligible2h = await dbQuery(
  `SELECT id FROM bookings WHERE id = $1::uuid AND reminder_2h_sent_at IS NULL
     AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled','no_show')
     AND (date + time) > NOW()
     AND (date + time) - make_interval(mins => $2::int) <= NOW()
     AND (date + time) - make_interval(mins => $3::int) >= NOW()`,
  [booking.id, 130, 110],
);

const logsAfter = await dbQuery(
  `SELECT action, COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE booking_id = $1::uuid
     AND action IN ('reminder_30m', 'reminder_24h', 'reminder_2h')
   GROUP BY 1`,
  [booking.id],
);

await dbQuery(
  `UPDATE bookings
   SET booking_status = 'cancelled',
       cancelled_at = NOW(),
       cancellation_reason = $2
   WHERE id = $1::uuid`,
  [booking.id, `Controlled AURA Phase 2 30m reminder test cleanup (${marker})`],
);

const counts = Object.fromEntries((logsAfter.rows || []).map((r) => [r.action, r.c]));
const at = CUSTOMER_EMAIL.indexOf("@");
const pass =
  Boolean(testRow?.reminder_sent_at) &&
  testRow?.reminder_24h_sent_at == null &&
  testRow?.reminder_2h_sent_at == null &&
  (logs30m.rows || []).length === 1 &&
  String(logs30m.rows?.[0]?.result || "") === "sent" &&
  Number(counts.reminder_30m || 0) === 1 &&
  Number(counts.reminder_24h || 0) === 0 &&
  Number(counts.reminder_2h || 0) === 0 &&
  Number(secondScan?.sent || 0) === 0 &&
  (eligible24h.rows || []).length === 0 &&
  (eligible2h.rows || []).length === 0 &&
  Number(othersRecent30m.rows?.[0]?.c || 0) === 0;

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
      reminder_sent_at: testRow?.reminder_sent_at || null,
      reminder_24h_still_null: testRow?.reminder_24h_sent_at == null,
      reminder_2h_still_null: testRow?.reminder_2h_sent_at == null,
      eligibleFor24hWindow: (eligible24h.rows || []).length > 0,
      eligibleFor2hWindow: (eligible2h.rows || []).length > 0,
      reminder30mLogCount: (logs30m.rows || []).length,
      reminder30mLogs: logs30m.rows || [],
      reminderActionCountsForBooking: counts,
      unintendedRecent30mStamps: othersRecent30m.rows?.[0]?.c ?? null,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
