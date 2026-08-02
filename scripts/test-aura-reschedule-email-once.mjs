#!/usr/bin/env node
/**
 * Controlled one-shot AURA Phase 2 reschedule-email verification.
 * Creates a disposable test booking, reschedules it once, sends the AURA
 * reschedule email via the Phase 2 hook, verifies one action-log row, then
 * cancels the test booking so it cannot occupy a live slot.
 *
 * Requires production flag AURA_PHASE2_RESCHEDULE_EMAIL (verified by caller).
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

// Match production flag matrix for the hook under test.
process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_RESCHEDULE_EMAIL = "true";
process.env.AURA_PHASE2_BARBER_NOTIFY = "true"; // production is on; IFCDC Barbers has no email
process.env.AURA_PHASE2_ADMIN_ALERTS = "true";

const { afterBookingRescheduled } = require("../auraPhase2Hooks.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");

const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f"; // IFCDC Barbers (no user email)
const BARBER_NAME = "IFCDC Barbers";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL ||
    process.env.BOOKING_ADMIN_EMAIL ||
    "service@ifcdc.org",
).trim();
const CUSTOMER_NAME = "AURA Phase 2 Reschedule Test";
const SERVICE = "Controlled reschedule verification";
const ORIGINAL_DATE = "2026-08-20";
const ORIGINAL_TIME = "10:00:00";
const ORIGINAL_TIME_LABEL = "10:00 AM";
const NEW_DATE = "2026-08-21";
const NEW_TIME = "14:00:00";
const NEW_TIME_LABEL = "02:00 PM";
const marker = `controlled_reschedule_email_test_${Date.now()}`;

const flags = auraPhase2Flags();
if (!flags.rescheduleEmailExtra) {
  console.error(JSON.stringify({ ok: false, error: "local_reschedule_flag_off", flags }));
  process.exit(1);
}

const inserted = await dbQuery(
  `INSERT INTO bookings (
      customer_name, customer_email, barber_id, barber_name, service,
      date, time, amount, payment_status, booking_status, is_paid_booking,
      total_price, notes
    ) VALUES (
      $1, $2, $3::uuid, $4, $5,
      $6::date, $7::time, 0, 'unpaid', 'confirmed', false,
      0, $8
    )
    RETURNING id, customer_name, customer_email, barber_id, barber_name, service,
              date::text AS date, to_char(time, 'HH12:MI AM') AS time,
              booking_status, total_price, amount_paid, total_paid`,
  [
    CUSTOMER_NAME,
    CUSTOMER_EMAIL,
    BARBER_ID,
    BARBER_NAME,
    SERVICE,
    ORIGINAL_DATE,
    ORIGINAL_TIME,
    `AURA Phase 2 controlled test marker=${marker}`,
  ],
);

const booking = inserted.rows?.[0];
if (!booking?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }));
  process.exit(1);
}

const fromLabel = `${ORIGINAL_DATE} ${ORIGINAL_TIME_LABEL}`;

const updated = await dbQuery(
  `UPDATE bookings
   SET date = $2::date,
       time = $3::time,
       rescheduled_from_date = COALESCE(rescheduled_from_date, $4::date),
       rescheduled_from_time = COALESCE(rescheduled_from_time, $5::time),
       rescheduled_to_date = $2::date,
       rescheduled_to_time = $3::time,
       rescheduled_by = 'aura_phase2_controlled_test',
       rescheduled_at = NOW()
   WHERE id = $1::uuid
   RETURNING id, customer_name, customer_email, barber_id, barber_name, service,
             date::text AS date, to_char(time, 'HH12:MI AM') AS time,
             booking_status, total_price, amount_paid, total_paid,
             rescheduled_from_date::text AS rescheduled_from_date,
             to_char(rescheduled_from_time, 'HH12:MI AM') AS rescheduled_from_time,
             rescheduled_to_date::text AS rescheduled_to_date,
             to_char(rescheduled_to_time, 'HH12:MI AM') AS rescheduled_to_time`,
  [booking.id, NEW_DATE, NEW_TIME, ORIGINAL_DATE, ORIGINAL_TIME],
);

const rescheduled = updated.rows?.[0];
if (!rescheduled?.id) {
  console.error(JSON.stringify({ ok: false, error: "reschedule_update_failed", bookingId: booking.id }));
  process.exit(1);
}

const beforeLogs = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE booking_id = $1::uuid
     AND action = 'hook_reschedule'`,
  [booking.id],
);

const hook = await afterBookingRescheduled(dbQuery, rescheduled, {
  fromLabel,
  newDate: NEW_DATE,
  newTime: NEW_TIME_LABEL,
});

await new Promise((r) => setTimeout(r, 500));

const afterLogs = await dbQuery(
  `SELECT id, created_at, action, result, metadata
   FROM aura_action_logs
   WHERE booking_id = $1::uuid
   ORDER BY created_at DESC`,
  [booking.id],
);

const hookLogs = (afterLogs.rows || []).filter((r) => r.action === "hook_reschedule");
const barberLogs = (afterLogs.rows || []).filter((r) => String(r.action || "").startsWith("barber_notify_"));

// Cancel test booking so it does not hold a live confirmed slot.
await dbQuery(
  `UPDATE bookings
   SET booking_status = 'cancelled',
       cancelled_at = NOW(),
       cancellation_reason = $2
   WHERE id = $1::uuid`,
  [booking.id, `Controlled AURA Phase 2 reschedule email test cleanup (${marker})`],
);

const finalRow = await dbQuery(
  `SELECT id, booking_status, date::text AS date,
          to_char(time, 'HH12:MI AM') AS time,
          customer_email, barber_name, service,
          rescheduled_from_date::text AS from_date,
          to_char(rescheduled_from_time, 'HH12:MI AM') AS from_time,
          rescheduled_to_date::text AS to_date,
          to_char(rescheduled_to_time, 'HH12:MI AM') AS to_time
   FROM bookings WHERE id = $1::uuid`,
  [booking.id],
);

const customerSend = hook?.customer || null;
const at = CUSTOMER_EMAIL.indexOf("@");
const pass =
  customerSend?.ok === true &&
  (beforeLogs.rows?.[0]?.c ?? 0) === 0 &&
  hookLogs.length === 1 &&
  String(hookLogs[0]?.result || "") === "ok" &&
  String(finalRow.rows?.[0]?.from_date || "") === ORIGINAL_DATE &&
  String(finalRow.rows?.[0]?.to_date || "") === NEW_DATE;

console.log(
  JSON.stringify(
    {
      ok: pass,
      marker,
      flags,
      bookingId: booking.id,
      recipientDomain: at > 0 ? CUSTOMER_EMAIL.slice(at + 1) : null,
      recipientPreview: at > 1 ? `${CUSTOMER_EMAIL[0]}***@${CUSTOMER_EMAIL.slice(at + 1)}` : null,
      original: { date: ORIGINAL_DATE, time: ORIGINAL_TIME_LABEL },
      newSlot: { date: NEW_DATE, time: NEW_TIME_LABEL },
      fromLabel,
      emailFields: {
        customerName: CUSTOMER_NAME,
        barberName: BARBER_NAME,
        service: SERVICE,
        originalTime: fromLabel,
        newTime: `${NEW_DATE} ${NEW_TIME_LABEL}`,
      },
      customerEmailSend: customerSend,
      barberNotifyResult: hook?.barber || null,
      beforeHookLogs: beforeLogs.rows?.[0]?.c ?? 0,
      hookRescheduleLogCount: hookLogs.length,
      hookLogs,
      barberNotifyLogCount: barberLogs.length,
      barberLogs,
      finalBooking: finalRow.rows?.[0] || null,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
