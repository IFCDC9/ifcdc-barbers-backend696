#!/usr/bin/env node
/**
 * Dry-run / preview AURA daily Super Admin report.
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/run-aura-daily-report.mjs
 *   node --import ./loadBackendEnv.mjs scripts/run-aura-daily-report.mjs --day=2026-08-01
 *   ... --send   (only works when AURA_DAILY_REPORT_ENABLED=1 — do not use in prod without approval)
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { generateAuraDailyReport } = require("../auraDailyReport.cjs");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const day = arg("day");
const forceSend = process.argv.includes("--send");

const out = await generateAuraDailyReport(dbQuery, {
  dayYmd: day,
  dryRun: !forceSend,
  forceSend,
});

console.log(JSON.stringify({
  ok: out.ok,
  dryRun: out.dryRun,
  sendEnabled: out.sendEnabled,
  day: out.stats?.day,
  sent: out.sent || false,
  error: out.error || null,
  stats: out.stats,
}, null, 2));

if (out.text) {
  console.log("\n--- preview ---\n");
  console.log(out.text);
}

process.exit(out.ok === false && forceSend ? 1 : 0);
