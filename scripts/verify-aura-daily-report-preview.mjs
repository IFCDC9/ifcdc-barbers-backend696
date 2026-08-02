#!/usr/bin/env node
/**
 * Controlled AURA daily report PREVIEW verification.
 * Never sends email. Compares each metric to independent DB queries.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_DAILY_REPORT_PREVIEW = "true";
process.env.AURA_DAILY_REPORT_ENABLED = "false";

const {
  generateAuraDailyReport,
  controlledTestSql,
  shopTimezone,
  reportDayBounds,
} = require("../auraDailyReport.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");

const API = "https://ifcdc-barbers-backend696.onrender.com";
const dayArg = process.argv.find((a) => a.startsWith("--day="))?.slice(6) || null;

async function liveFlags() {
  const res = await fetch(`${API}/api/aura/phase2/status`);
  return res.json();
}

const flagsLive = await liveFlags();
const localFlags = auraPhase2Flags();
const bounds = reportDayBounds(dayArg);
const day = bounds.day;
const tz = bounds.timezone;
const testSql = controlledTestSql();

const bookingsFingerprintBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c,
          md5(string_agg(id::text || ':' || coalesce(booking_status,'') || ':' || coalesce(payment_status,''), ',' ORDER BY id)) AS fp
   FROM bookings`,
);
const usersFingerprintBefore = await dbQuery(`SELECT COUNT(*)::int AS c FROM app_users`);
const logsBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'daily_report_preview'`,
);
const sendLogsBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'daily_report_send'`,
);

const preview = await generateAuraDailyReport(dbQuery, {
  dayYmd: day,
  dryRun: true,
  forceSend: false,
});

await new Promise((r) => setTimeout(r, 300));

const bookingsFingerprintAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c,
          md5(string_agg(id::text || ':' || coalesce(booking_status,'') || ':' || coalesce(payment_status,''), ',' ORDER BY id)) AS fp
   FROM bookings`,
);
const usersFingerprintAfter = await dbQuery(`SELECT COUNT(*)::int AS c FROM app_users`);
const logsAfter = await dbQuery(
  `SELECT id, action, result, metadata, created_at
   FROM aura_action_logs
   WHERE action = 'daily_report_preview'
   ORDER BY created_at DESC LIMIT 3`,
);
const sendLogsAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'daily_report_send'`,
);

// Independent DB metric checks (same exclusion rules)
const indep = await dbQuery(
  `SELECT
     COUNT(*) FILTER (WHERE date = $1::date AND NOT ${testSql})::int AS total_bookings,
     COUNT(*) FILTER (
       WHERE date = $1::date AND lower(coalesce(booking_status,'')) = 'completed' AND NOT ${testSql}
     )::int AS completed,
     COUNT(*) FILTER (
       WHERE date = $1::date AND lower(coalesce(booking_status,'')) IN ('cancelled','canceled') AND NOT ${testSql}
     )::int AS cancellations,
     COUNT(*) FILTER (
       WHERE date = $1::date AND lower(coalesce(booking_status,'')) IN ('no_show','noshow') AND NOT ${testSql}
     )::int AS no_shows,
     COUNT(*) FILTER (
       WHERE date > $1::date
         AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','no_show','noshow')
         AND NOT ${testSql}
     )::int AS upcoming_after,
     COUNT(*) FILTER (
       WHERE date = $1::date
         AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','completed','no_show','noshow')
         AND (date + time) > NOW()
         AND NOT ${testSql}
     )::int AS upcoming_today,
     COALESCE(SUM(
       CASE
         WHEN date = $1::date AND NOT ${testSql}
          AND COALESCE(amount_paid, total_paid, 0) > 0 AND refunded_at IS NULL
         THEN COALESCE(amount_paid, total_paid, 0) ELSE 0 END
     ), 0)::float AS payments,
     COUNT(*) FILTER (WHERE date = $1::date AND ${testSql})::int AS controlled_tests
   FROM bookings`,
  [day],
);
const i = indep.rows?.[0] || {};

const failedEmailsIndep = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE (created_at AT TIME ZONE $2)::date = $1::date
     AND (
       lower(coalesce(result,'')) LIKE '%fail%'
       OR action LIKE '%failed%'
       OR action = 'admin_alert'
     )`,
  [day, tz],
);
const failedPaymentsIndep = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM bookings
   WHERE (created_at AT TIME ZONE $2)::date = $1::date
     AND NOT ${testSql}
     AND (
       lower(coalesce(payment_status,'')) LIKE '%fail%'
       OR lower(coalesce(payment_status,'')) = 'error'
     )`,
  [day, tz],
);
const conflictsIndep = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM (
     SELECT 1
     FROM bookings
     WHERE date = $1::date
       AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled')
       AND barber_id IS NOT NULL
       AND NOT ${testSql}
     GROUP BY barber_id, date, time
     HAVING COUNT(*) > 1
   ) x`,
  [day],
);

const s = preview.stats || {};
const metricChecks = {
  totalBookings: Number(s.totalBookings) === Number(i.total_bookings),
  completedAppointments: Number(s.completedAppointments) === Number(i.completed),
  upcomingAppointments:
    Number(s.upcomingAppointments) === Number(i.upcoming_after) + Number(i.upcoming_today),
  paymentsReceived: Number(s.paymentsReceived) === Number(i.payments),
  cancellations: Number(s.cancellations) === Number(i.cancellations),
  noShows: Number(s.noShows) === Number(i.no_shows),
  failedEmails: Number(s.failedEmails) === Number(failedEmailsIndep.rows?.[0]?.c || 0),
  failedPayments: Number(s.failedPayments) === Number(failedPaymentsIndep.rows?.[0]?.c || 0),
  schedulingConflicts: Number(s.schedulingConflicts) === Number(conflictsIndep.rows?.[0]?.c || 0),
  controlledTestExcluded:
    Number(s.controlledTestBookingsExcluded) === Number(i.controlled_tests),
};

const newPreviewLogs = (logsAfter.rows || []).filter(
  (r) => new Date(r.created_at).getTime() >= Date.now() - 60_000,
);
const text = String(preview.text || "");
const checks = {
  livePreviewFlag: flagsLive?.flags?.dailyReportPreview === true,
  liveSendFlagOff: flagsLive?.flags?.dailyReportSend === false,
  localPreviewFlag: localFlags.dailyReportPreview === true,
  localSendFlagOff: localFlags.dailyReportSend === false,
  previewOk: preview.ok === true,
  dryRun: preview.dryRun === true,
  notSent: preview.sent !== true,
  sendEnabledFalse: preview.sendEnabled === false,
  hasPeriod: /Reporting period:/i.test(text),
  hasTimezone: /Timezone:/i.test(text) && text.includes(tz),
  hasAllSections: [
    "Total bookings",
    "Completed appointments",
    "Upcoming appointments",
    "Payments received",
    "Cancellations",
    "No-shows",
    "Failed emails",
    "Failed payments",
    "Scheduling conflicts",
    "Items requiring Super Admin attention",
    "Controlled test bookings excluded",
  ].every((k) => text.includes(k)),
  noPiiLeak:
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(text.replace(/service@ifcdc\.org/gi, "")) &&
    !/password|card|cvv|ssn|paypal_order/i.test(text),
  privacyNotePresent: /Aggregate counts only/i.test(text),
  oneNewPreviewLog: newPreviewLogs.length === 1 && newPreviewLogs[0].result === "dry_run",
  noSendLogCreated:
    Number(sendLogsAfter.rows?.[0]?.c || 0) === Number(sendLogsBefore.rows?.[0]?.c || 0),
  bookingsUnchanged:
    Number(bookingsFingerprintBefore.rows?.[0]?.c) ===
      Number(bookingsFingerprintAfter.rows?.[0]?.c) &&
    String(bookingsFingerprintBefore.rows?.[0]?.fp) ===
      String(bookingsFingerprintAfter.rows?.[0]?.fp),
  usersUnchanged:
    Number(usersFingerprintBefore.rows?.[0]?.c) === Number(usersFingerprintAfter.rows?.[0]?.c),
};

const metricPassFail = Object.fromEntries(
  Object.entries(metricChecks).map(([k, v]) => [k, v ? "PASS" : "FAIL"]),
);
const pass =
  Object.values(checks).every(Boolean) && Object.values(metricChecks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok: pass,
      verdict: pass ? "PASS" : "FAIL",
      feature: "AURA_DAILY_REPORT_PREVIEW",
      day,
      timezone: tz,
      periodLabel: bounds.periodLabel,
      flagsLive: flagsLive?.flags,
      previewSummary: {
        ok: preview.ok,
        dryRun: preview.dryRun,
        sent: preview.sent || false,
        sendEnabled: preview.sendEnabled,
        previewEnabled: preview.previewEnabled,
      },
      stats: s,
      independentDb: {
        totalBookings: i.total_bookings,
        completed: i.completed,
        upcoming: Number(i.upcoming_after) + Number(i.upcoming_today),
        payments: i.payments,
        cancellations: i.cancellations,
        noShows: i.no_shows,
        failedEmails: failedEmailsIndep.rows?.[0]?.c,
        failedPayments: failedPaymentsIndep.rows?.[0]?.c,
        schedulingConflicts: conflictsIndep.rows?.[0]?.c,
        controlledTests: i.controlled_tests,
      },
      metricPassFail,
      checks,
      previewLog: newPreviewLogs[0] || null,
      previewText: text,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
