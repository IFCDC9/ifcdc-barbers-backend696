#!/usr/bin/env node
/**
 * One controlled live-send of the AURA daily Super Admin report.
 * Does NOT arm recurring delivery.
 *
 *   node --import ./loadBackendEnv.mjs scripts/send-aura-daily-report-once.mjs
 *   node --import ./loadBackendEnv.mjs scripts/send-aura-daily-report-once.mjs --day=2026-08-02
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_DAILY_REPORT_PREVIEW = "true";
process.env.AURA_DAILY_REPORT_ENABLED = "true";

const { generateAuraDailyReport } = require("../auraDailyReport.cjs");

const day = process.argv.find((a) => a.startsWith("--day="))?.slice(6) || null;
const forceResend = process.argv.includes("--force-resend");

const sendLogsBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'daily_report_send' AND result = 'sent'`,
);

const out = await generateAuraDailyReport(dbQuery, {
  dayYmd: day,
  dryRun: false,
  forceSend: true,
  forceResend,
  controlledLiveSend: true,
});

await new Promise((r) => setTimeout(r, 400));

const sendLogs = await dbQuery(
  `SELECT id, action, result, metadata, created_at
   FROM aura_action_logs
   WHERE action = 'daily_report_send'
   ORDER BY created_at DESC
   LIMIT 5`,
);
const sentToday = (sendLogs.rows || []).filter(
  (r) => r.result === "sent" && r.metadata?.day === (out.stats?.day || day),
);

const checks = {
  ok: out.ok === true,
  sent: out.sent === true,
  recipientIsService: String(out.recipient || "").toLowerCase() === "service@ifcdc.org",
  dryRunFalse: out.dryRun === false,
  oneSentLogForDay: sentToday.length === 1,
  sendIncreasedByOne:
    Number(sendLogsBefore.rows?.[0]?.c || 0) + 1 ===
    (await dbQuery(
      `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = 'daily_report_send' AND result = 'sent'`,
    )).rows[0].c,
};

const pass = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok: pass,
      verdict: pass ? "PASS" : "FAIL",
      feature: "AURA_DAILY_REPORT_LIVE_SEND_ONCE",
      recipient: out.recipient,
      day: out.stats?.day,
      timezone: out.stats?.timezone,
      sent: out.sent,
      skippedDuplicate: out.skippedDuplicate || false,
      error: out.error || null,
      stats: out.stats,
      text: out.text,
      sentLog: sentToday[0] || null,
      checks,
      note: "Recurring automatic delivery is NOT armed by this script.",
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
