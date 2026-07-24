import { createRequire } from "module";
import { dbQuery } from "./db.js";

const require = createRequire(import.meta.url);

/**
 * Send ~30-minute-before reminders for confirmed bookings (best-effort; idempotent via reminder_sent_at).
 * Call from a short interval (e.g. 60s) on the API process.
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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
