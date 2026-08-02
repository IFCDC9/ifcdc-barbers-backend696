import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);
const KEYS = [
  "AURA_PHASE2_ENABLED",
  "AURA_DAILY_REPORT_ENABLED",
  "AURA_DAILY_REPORT_PREVIEW",
  "AURA_DAILY_REPORT_HOUR",
  "AURA_DAILY_REPORT_MINUTE",
  "SHOP_TIMEZONE",
  "BOOKING_ADMIN_EMAIL",
];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("schedule requires hour env and reports next 7:00 America/New_York", () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_HOUR = "7";
  process.env.AURA_DAILY_REPORT_MINUTE = "0";
  process.env.SHOP_TIMEZONE = "America/New_York";
  process.env.BOOKING_ADMIN_EMAIL = "service@ifcdc.org";

  const { getNextDailyReportRunAt, getDailyReportScheduleConfig } = require(
    "../auraDailyReportScheduler.cjs",
  );
  const cfg = getDailyReportScheduleConfig();
  assert.equal(cfg.hour, 7);
  assert.equal(cfg.minute, 0);
  assert.equal(cfg.timezone, "America/New_York");
  assert.equal(cfg.recipient, "service@ifcdc.org");
  assert.equal(cfg.scheduleConfigured, true);

  // Fixed instant: 2026-08-02 12:17 UTC ≈ 08:17 America/New_York → next is Aug 3 07:00
  const next = getNextDailyReportRunAt(new Date("2026-08-02T12:17:00.000Z"));
  assert.equal(next.ok, true);
  assert.equal(next.schedulerArmed, true);
  assert.match(next.nextRunLocal, /2026-08-03 07:00 America\/New_York/);
});

test("scheduler not configured without hour", () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_ENABLED = "1";
  const { getDailyReportScheduleConfig } = require("../auraDailyReportScheduler.cjs");
  const cfg = getDailyReportScheduleConfig();
  assert.equal(cfg.scheduleConfigured, false);
});
