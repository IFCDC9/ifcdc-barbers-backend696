/**
 * Lightweight reminder window math helpers covered indirectly via flag gates.
 * Full DB window queries are exercised in ops dry-run when flags are enabled locally.
 */
import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = [
  "AURA_PHASE2_ENABLED",
  "AURA_PHASE2_REMINDERS_24H",
  "AURA_PHASE2_REMINDERS_2H",
  "AURA_PHASE2_REMINDERS_30M",
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

test("reminder scanners no-op when flags off", async () => {
  const mod = await import("../bookingReminders.js");
  const a = await mod.scanAndSendBookingReminders24h();
  const b = await mod.scanAndSendBookingReminders2h();
  const all = await mod.scanAllEnabledBookingReminders();
  assert.equal(a.skipped, "flag_off");
  assert.equal(b.skipped, "flag_off");
  assert.equal(all["24h"], null);
  assert.equal(all["2h"], null);
  assert.equal(all["30m"], null);
});

test("phase2 emails export expected templates", () => {
  const emails = require("../auraPhase2Emails.cjs");
  assert.equal(typeof emails.sendAuraReminderEmail, "function");
  assert.equal(typeof emails.sendAuraCancelEmail, "function");
  assert.equal(typeof emails.sendAuraRescheduleEmail, "function");
  assert.equal(typeof emails.sendAuraBarberEventEmail, "function");
  assert.equal(typeof emails.sendAuraAdminFailureAlert, "function");
  assert.equal(typeof emails.sendAuraReviewFollowupEmail, "function");
  const fields = emails.bookingFields({
    customerName: "Test",
    customerEmail: "t@example.com",
    barberName: "Barber",
    service: "Cut",
    date: "2026-08-10",
    time: "10:00 AM",
    price: 30,
    bookingId: "abc",
  });
  assert.equal(fields.price, "30.00");
  assert.equal(fields.bookingId, "abc");
});
