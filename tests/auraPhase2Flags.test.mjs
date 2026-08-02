import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = [
  "AURA_PHASE2_ENABLED",
  "AURA_PHASE2_REMINDERS_24H",
  "AURA_PHASE2_REMINDERS_2H",
  "AURA_PHASE2_REMINDERS_30M",
  "AURA_PHASE2_BARBER_NOTIFY",
  "AURA_PHASE2_ADMIN_ALERTS",
  "AURA_PHASE2_TOOLS_ENABLED",
  "AURA_PHASE2_REVIEW_FOLLOWUP",
  "AURA_PHASE2_RESCHEDULE_EMAIL",
  "AURA_DAILY_REPORT_PREVIEW",
  "AURA_DAILY_REPORT_ENABLED",
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

test("Phase 2 flags default off", () => {
  const { auraPhase2Flags, isAuraPhase2Enabled, auraReceptionistIdentity } = require("../auraPhase2Flags.cjs");
  assert.equal(isAuraPhase2Enabled(), false);
  const f = auraPhase2Flags();
  assert.equal(f.master, false);
  assert.equal(f.reminders24h, false);
  assert.equal(f.reminders2h, false);
  assert.equal(f.toolsEnabled, false);
  assert.equal(f.dailyReportSend, false);
  assert.match(auraReceptionistIdentity(), /digital receptionist/);
  assert.doesNotMatch(auraReceptionistIdentity(), /\bAI\b/i);
});

test("subflags require master", () => {
  process.env.AURA_PHASE2_REMINDERS_24H = "1";
  process.env.AURA_PHASE2_TOOLS_ENABLED = "1";
  process.env.AURA_DAILY_REPORT_ENABLED = "1";
  const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");
  const f = auraPhase2Flags();
  assert.equal(f.reminders24h, false);
  assert.equal(f.toolsEnabled, false);
  assert.equal(f.dailyReportSend, false);

  process.env.AURA_PHASE2_ENABLED = "1";
  const on = auraPhase2Flags();
  assert.equal(on.master, true);
  assert.equal(on.reminders24h, true);
  assert.equal(on.toolsEnabled, true);
  assert.equal(on.dailyReportSend, true);
});
