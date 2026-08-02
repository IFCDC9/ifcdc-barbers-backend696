/**
 * AURA daily Super Admin report — foundation (query + preview + dry-run).
 * Automatic sending requires AURA_DAILY_REPORT_ENABLED (second controlled step).
 */
const { auraPhase2Flags, flagOn } = require("./auraPhase2Flags.cjs");
const { sendEmail, getMailFrom } = require("./emailResend.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

function reportDayBounds(dayYmd) {
  const day = String(dayYmd || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { day, start: `${day} 00:00:00`, end: `${day} 23:59:59.999` };
  }
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const today = `${y}-${m}-${d}`;
  return { day: today, start: `${today} 00:00:00`, end: `${today} 23:59:59.999` };
}

async function gatherDailyReportStats(dbQuery, { dayYmd } = {}) {
  const { day } = reportDayBounds(dayYmd);

  const totals = await dbQuery(
    `SELECT
       COUNT(*) FILTER (WHERE date = $1::date)::int AS bookings_on_day,
       COUNT(*) FILTER (
         WHERE date = $1::date
           AND lower(coalesce(booking_status,'')) = 'completed'
       )::int AS completed,
       COUNT(*) FILTER (
         WHERE date = $1::date
           AND lower(coalesce(booking_status,'')) IN ('cancelled','canceled')
       )::int AS cancellations,
       COUNT(*) FILTER (
         WHERE date = $1::date
           AND lower(coalesce(booking_status,'')) IN ('no_show','noshow')
       )::int AS no_shows,
       COUNT(*) FILTER (
         WHERE date > $1::date
           AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','no_show','noshow')
       )::int AS upcoming_after_day,
       COUNT(*) FILTER (
         WHERE date = $1::date
           AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','completed','no_show','noshow')
           AND (date + time) > NOW()
       )::int AS upcoming_remaining_today,
       COALESCE(SUM(
         CASE
           WHEN date = $1::date
            AND COALESCE(amount_paid, total_paid, 0) > 0
            AND refunded_at IS NULL
           THEN COALESCE(amount_paid, total_paid, 0)
           ELSE 0
         END
       ), 0)::float AS payments_received
     FROM bookings`,
    [day],
  );

  let failedEmails = 0;
  let schedulingConflicts = 0;
  let attentionItems = [];

  try {
    const logs = await dbQuery(
      `SELECT COUNT(*)::int AS c
       FROM aura_action_logs
       WHERE created_at::date = $1::date
         AND (
           lower(coalesce(result,'')) LIKE '%fail%'
           OR action LIKE '%failed%'
           OR action = 'admin_alert'
         )`,
      [day],
    );
    failedEmails = Number(logs.rows?.[0]?.c) || 0;
  } catch {
    failedEmails = 0;
  }

  try {
    const dup = await dbQuery(
      `SELECT barber_id, date::text AS date, time::text AS time, COUNT(*)::int AS c
       FROM bookings
       WHERE date = $1::date
         AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled')
         AND barber_id IS NOT NULL
       GROUP BY barber_id, date, time
       HAVING COUNT(*) > 1
       LIMIT 20`,
      [day],
    );
    schedulingConflicts = (dup.rows || []).length;
    if (schedulingConflicts) {
      attentionItems.push({
        kind: "scheduling_conflicts",
        count: schedulingConflicts,
        samples: (dup.rows || []).slice(0, 5),
      });
    }
  } catch {
    schedulingConflicts = 0;
  }

  let failedPayments = 0;
  try {
    const pay = await dbQuery(
      `SELECT COUNT(*)::int AS c
       FROM bookings
       WHERE created_at::date = $1::date
         AND (
           lower(coalesce(payment_status,'')) LIKE '%fail%'
           OR lower(coalesce(payment_status,'')) = 'error'
         )`,
      [day],
    );
    failedPayments = Number(pay.rows?.[0]?.c) || 0;
  } catch {
    failedPayments = 0;
  }

  if (failedEmails) attentionItems.push({ kind: "failed_emails_or_alerts", count: failedEmails });
  if (failedPayments) attentionItems.push({ kind: "failed_payments", count: failedPayments });

  const row = totals.rows?.[0] || {};
  return {
    day,
    generatedAt: new Date().toISOString(),
    totalBookings: Number(row.bookings_on_day) || 0,
    completedAppointments: Number(row.completed) || 0,
    upcomingAppointments:
      (Number(row.upcoming_remaining_today) || 0) + (Number(row.upcoming_after_day) || 0),
    upcomingRemainingToday: Number(row.upcoming_remaining_today) || 0,
    paymentsReceived: Number(row.payments_received) || 0,
    cancellations: Number(row.cancellations) || 0,
    noShows: Number(row.no_shows) || 0,
    failedEmails,
    failedPayments,
    schedulingConflicts,
    itemsRequiringAttention: attentionItems,
  };
}

function formatDailyReportText(stats) {
  const lines = [
    `IFCDC Barbers — Daily Super Admin Report (${stats.day})`,
    `Generated: ${stats.generatedAt}`,
    "",
    `Total bookings (day): ${stats.totalBookings}`,
    `Completed: ${stats.completedAppointments}`,
    `Upcoming (remaining today + future): ${stats.upcomingAppointments}`,
    `Payments received: $${Number(stats.paymentsReceived || 0).toFixed(2)}`,
    `Cancellations: ${stats.cancellations}`,
    `No-shows: ${stats.noShows}`,
    `Failed emails / alerts logged: ${stats.failedEmails}`,
    `Failed payments: ${stats.failedPayments}`,
    `Scheduling conflicts: ${stats.schedulingConflicts}`,
    "",
    "Items requiring Super Admin attention:",
  ];
  if (!stats.itemsRequiringAttention?.length) {
    lines.push("- None flagged");
  } else {
    for (const item of stats.itemsRequiringAttention) {
      lines.push(`- ${item.kind}: ${item.count}`);
    }
  }
  lines.push("");
  lines.push("Sent by AURA, the IFCDC Barbers digital receptionist.");
  return lines.join("\n");
}

/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true] — default true; never sends unless dryRun=false AND flag on
 * @param {boolean} [opts.forceSend=false]
 */
async function generateAuraDailyReport(dbQuery, opts = {}) {
  const flags = auraPhase2Flags();
  const dryRun = opts.dryRun !== false;
  const dayYmd = opts.dayYmd || null;
  const stats = await gatherDailyReportStats(dbQuery, { dayYmd });
  const text = formatDailyReportText(stats);
  const html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</pre>`;

  const preview = {
    ok: true,
    dryRun,
    sendEnabled: Boolean(flags.dailyReportSend),
    previewEnabled: Boolean(flags.dailyReportPreview || flags.master),
    stats,
    text,
    html,
    mailFrom: getMailFrom() || null,
    recipient:
      String(process.env.AURA_DAILY_REPORT_TO || process.env.BOOKING_ADMIN_EMAIL || "").trim() ||
      null,
  };

  if (dryRun || !opts.forceSend) {
    await logAuraAction(dbQuery, {
      action: "daily_report_preview",
      result: "dry_run",
      metadata: { day: stats.day, totals: {
        totalBookings: stats.totalBookings,
        completed: stats.completedAppointments,
      } },
    }).catch(() => {});
    return preview;
  }

  if (!flags.dailyReportSend) {
    return { ...preview, ok: false, error: "AURA_DAILY_REPORT_ENABLED_off", sent: false };
  }

  const to = preview.recipient;
  if (!to) return { ...preview, ok: false, error: "no_recipient", sent: false };
  if (!preview.mailFrom) return { ...preview, ok: false, error: "MAIL_FROM_missing", sent: false };

  const out = await sendEmail({
    to,
    subject: `IFCDC Barbers daily report — ${stats.day}`,
    html,
    text,
    label: "aura-daily-report",
  });
  const sent = !out?.error;
  await logAuraAction(dbQuery, {
    action: "daily_report_send",
    result: sent ? "sent" : "failed",
    metadata: { day: stats.day, error: out?.error?.message || null },
  }).catch(() => {});

  return {
    ...preview,
    dryRun: false,
    sent,
    ok: sent,
    error: out?.error?.message || null,
  };
}

module.exports = {
  reportDayBounds,
  gatherDailyReportStats,
  formatDailyReportText,
  generateAuraDailyReport,
  flagOn,
};
