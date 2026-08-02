import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = [
  "AURA_PHASE2_ENABLED",
  "AURA_DAILY_REPORT_PREVIEW",
  "AURA_DAILY_REPORT_ENABLED",
  "AURA_DAILY_REPORT_TO",
  "BOOKING_ADMIN_EMAIL",
];
const saved = {};

beforeEach(() => {
  for (const k of FLAG_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of FLAG_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("formatDailyReportText includes required sections", () => {
  const { formatDailyReportText } = require("../auraDailyReport.cjs");
  const text = formatDailyReportText({
    day: "2026-08-01",
    timezone: "America/New_York",
    periodLabel: "2026-08-01 00:00–23:59 (America/New_York)",
    generatedAt: "2026-08-02T00:00:00.000Z",
    totalBookings: 3,
    completedAppointments: 1,
    upcomingAppointments: 4,
    paymentsReceived: 45.5,
    cancellations: 1,
    noShows: 0,
    failedEmails: 0,
    failedPayments: 0,
    schedulingConflicts: 0,
    controlledTestBookingsExcluded: 2,
    itemsRequiringAttention: [],
  });
  assert.match(text, /Total bookings/);
  assert.match(text, /Completed/);
  assert.match(text, /Payments received: \$45\.50/);
  assert.match(text, /Timezone: America\/New_York/);
  assert.match(text, /Controlled test bookings excluded/);
  assert.match(text, /digital receptionist/);
});

test("generateAuraDailyReport dry-run never sends even if send flag on", async () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_PREVIEW = "1";
  process.env.AURA_DAILY_REPORT_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_TO = "admin@example.com";

  const calls = [];
  const fakeDb = async (sql) => {
    calls.push(String(sql).slice(0, 80));
    if (/FROM aura_action_logs/i.test(sql)) return { rows: [{ c: 0 }] };
    if (/GROUP BY barber_id/i.test(sql)) return { rows: [] };
    if (/payment_status/i.test(sql) && /COUNT/i.test(sql)) return { rows: [{ c: 0 }] };
    if (/INSERT INTO aura_action_logs/i.test(sql) || /CREATE TABLE/i.test(sql) || /CREATE INDEX/i.test(sql)) {
      return { rows: [] };
    }
    return {
      rows: [
        {
          bookings_on_day: 2,
          completed: 1,
          cancellations: 0,
          no_shows: 0,
          upcoming_after_day: 3,
          upcoming_remaining_today: 1,
          payments_received: 20,
        },
      ],
    };
  };

  const { generateAuraDailyReport } = require("../auraDailyReport.cjs");
  const out = await generateAuraDailyReport(fakeDb, { dryRun: true, dayYmd: "2026-08-01" });
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.sent, false);
  assert.equal(out.stats.totalBookings, 2);
  assert.equal(out.stats.completedAppointments, 1);
  assert.ok(out.text.includes("2026-08-01"));
});

test("force send blocked when AURA_DAILY_REPORT_ENABLED off", async () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  // send flag intentionally off
  const fakeDb = async (sql) => {
    if (/INSERT INTO aura_action_logs/i.test(sql) || /CREATE /i.test(sql)) return { rows: [] };
    if (/FROM aura_action_logs/i.test(sql)) return { rows: [{ c: 0 }] };
    if (/GROUP BY barber_id/i.test(sql)) return { rows: [] };
    if (/payment_status/i.test(sql) && /COUNT/i.test(sql)) return { rows: [{ c: 0 }] };
    return {
      rows: [
        {
          bookings_on_day: 0,
          completed: 0,
          cancellations: 0,
          no_shows: 0,
          upcoming_after_day: 0,
          upcoming_remaining_today: 0,
          payments_received: 0,
        },
      ],
    };
  };
  const { generateAuraDailyReport } = require("../auraDailyReport.cjs");
  const out = await generateAuraDailyReport(fakeDb, {
    dryRun: false,
    forceSend: true,
    dayYmd: "2026-08-01",
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "AURA_DAILY_REPORT_ENABLED_off");
  assert.equal(out.sent, false);
});
