import { createRequire } from "module";
import { dbQuery } from "./db.js";

const require = createRequire(import.meta.url);

/**
 * Booking reminder scanners.
 * Legacy ~30m path preserved.
 * Phase 2 adds 24h + 2h windows behind feature flags (idempotent columns).
 */

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadPhase2() {
  try {
    return {
      flags: require("./auraPhase2Flags.cjs").auraPhase2Flags(),
      emails: require("./auraPhase2Emails.cjs"),
      log: require("./auraActionLog.cjs"),
    };
  } catch {
    return null;
  }
}

/**
 * Send ~30-minute-before reminders for confirmed bookings (best-effort; idempotent via reminder_sent_at).
 */
export async function scanAndSendBookingReminders() {
  const { getResend, sendEmail } = require("./emailResend.cjs");
  if (!getResend()) return { sent: 0, skipped: "no_resend" };

  const { customerEmailLabels, tLabel } = require("./customerEmailI18n.cjs");
  const { resolveCustomerLanguage } = await import("./customerLanguage.js");

  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service, date::text AS date, to_char(time, 'HH24:MI') AS time,
            user_id
     FROM bookings
     WHERE reminder_sent_at IS NULL
       AND status NOT IN ('cancelled', 'canceled')
       AND booking_status NOT IN ('cancelled', 'canceled', 'no_show')
       AND (date + time) > NOW()
       AND (date + time) - INTERVAL '32 minutes' <= NOW()
       AND (date + time) - INTERVAL '28 minutes' >= NOW()
     LIMIT 25`,
  );
  const rows = r.rows || [];
  let sent = 0;
  for (const row of rows) {
    const to = String(row.customer_email || "").trim();
    if (!to) continue;
    const name = String(row.customer_name || "there").trim();
    const when = `${row.date} ${row.time}`.trim();
    const language = await resolveCustomerLanguage({
      userId: row.user_id || null,
      customerEmail: to,
    });
    const labels = customerEmailLabels(language);
    const barber = String(row.barber_name || "your barber");
    const service = String(row.service || "service");
    const subj = tLabel(labels, "reminderSubject");
    const html = `<p>${escapeHtml(tLabel(labels, "reminderHi", { name }))}</p>
<p>${tLabel(labels, "reminderBody", {
      when: escapeHtml(when),
      barber: escapeHtml(barber),
      service: escapeHtml(service),
    })}</p>
<p>${escapeHtml(tLabel(labels, "reminderSeeYou"))}</p>`;
    try {
      const out = await sendEmail({
        to,
        subject: subj,
        html,
        text: tLabel(labels, "reminderText", { name, when }),
        label: "booking-reminder",
      });
      if (out?.error) throw new Error(out.error.message || "send failed");
      await dbQuery(`UPDATE bookings SET reminder_sent_at = NOW() WHERE id = $1::uuid`, [row.id]);
      sent += 1;
    } catch (e) {
      console.warn("[reminder] skip booking", row.id, e?.message || e);
    }
  }
  return { sent, checked: rows.length };
}

async function scanWindow({
  column,
  windowLabel,
  lowerMinutes,
  upperMinutes,
  limit = 25,
}) {
  const phase2 = await loadPhase2();
  if (!phase2) return { sent: 0, skipped: "phase2_unavailable" };
  const { emails, log } = phase2;
  const { getResend } = require("./emailResend.cjs");
  if (!getResend()) return { sent: 0, skipped: "no_resend" };

  await log.ensureAuraReminderColumns(dbQuery);

  const allowedColumns = new Set(["reminder_24h_sent_at", "reminder_2h_sent_at"]);
  if (!allowedColumns.has(column)) {
    return { sent: 0, skipped: "invalid_column" };
  }

  const lo = Math.max(1, Number(lowerMinutes) || 0);
  const hi = Math.max(1, Number(upperMinutes) || 0);
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));

  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service,
            date::text AS date,
            to_char(time, 'HH12:MI AM') AS time_ampm,
            to_char(time, 'HH24:MI') AS time,
            user_id,
            COALESCE(total_paid, amount_paid, total_amount, total_price, service_price) AS price
     FROM bookings
     WHERE ${column} IS NULL
       AND COALESCE(booking_status, '') NOT IN ('cancelled', 'canceled', 'no_show')
       AND (date + time) > NOW()
       AND (date + time) - make_interval(mins => $1::int) <= NOW()
       AND (date + time) - make_interval(mins => $2::int) >= NOW()
     LIMIT $3`,
    [lo, hi, lim],
  );

  const rows = r.rows || [];
  let sent = 0;
  for (const row of rows) {
    const to = String(row.customer_email || "").trim();
    if (!to) continue;
    try {
      const out = await emails.sendAuraReminderEmail(
        {
          customerName: row.customer_name,
          customerEmail: to,
          barberName: row.barber_name,
          service: row.service,
          date: row.date,
          time: row.time_ampm || row.time,
          price: row.price,
          bookingId: row.id,
        },
        windowLabel,
      );
      if (!out?.ok) throw new Error(out?.error || "send_failed");
      await dbQuery(`UPDATE bookings SET ${column} = NOW() WHERE id = $1::uuid`, [row.id]);
      await log.logAuraAction(dbQuery, {
        action: `reminder_${windowLabel}`,
        bookingId: row.id,
        result: "sent",
        metadata: { to },
      });
      sent += 1;
    } catch (e) {
      console.warn(`[reminder-${windowLabel}] skip`, row.id, e?.message || e);
      if (phase2.flags.adminAlerts) {
        void emails.sendAuraAdminFailureAlert({
          kind: `reminder_${windowLabel}_failed`,
          detail: { bookingId: row.id, error: e?.message || String(e) },
        });
      }
    }
  }
  return { sent, checked: rows.length, window: windowLabel };
}

/** 24h window: between 25h and 23h before start */
export async function scanAndSendBookingReminders24h() {
  const phase2 = await loadPhase2();
  if (!phase2?.flags?.reminders24h) return { sent: 0, skipped: "flag_off" };
  return scanWindow({
    column: "reminder_24h_sent_at",
    windowLabel: "24h",
    lowerMinutes: 25 * 60,
    upperMinutes: 23 * 60,
  });
}

/** 2h window: between 130 and 110 minutes before start */
export async function scanAndSendBookingReminders2h() {
  const phase2 = await loadPhase2();
  if (!phase2?.flags?.reminders2h) return { sent: 0, skipped: "flag_off" };
  return scanWindow({
    column: "reminder_2h_sent_at",
    windowLabel: "2h",
    lowerMinutes: 130,
    upperMinutes: 110,
  });
}

/** Run all enabled reminder scanners (Phase 2 + optional legacy 30m). */
export async function scanAllEnabledBookingReminders() {
  const phase2 = await loadPhase2();
  const out = { "24h": null, "2h": null, "30m": null };
  if (phase2?.flags?.reminders24h) out["24h"] = await scanAndSendBookingReminders24h();
  if (phase2?.flags?.reminders2h) out["2h"] = await scanAndSendBookingReminders2h();
  if (phase2?.flags?.reminders30m) out["30m"] = await scanAndSendBookingReminders();
  return out;
}
