import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBookingWindowDays, DEFAULT_BOOKING_WINDOW_DAYS } from "../bookingWindow.js";
import { checkDateWithinBookingWindow } from "../barberSlotEngine.js";

test("normalizeBookingWindowDays accepts known options", () => {
  assert.equal(normalizeBookingWindowDays(30), 30);
  assert.equal(normalizeBookingWindowDays(90), 90);
  assert.equal(normalizeBookingWindowDays(365), 365);
});

test("normalizeBookingWindowDays defaults unknown", () => {
  assert.equal(normalizeBookingWindowDays(null), DEFAULT_BOOKING_WINDOW_DAYS);
});

test("checkDateWithinBookingWindow blocks past and far future", () => {
  const schedule = {
    timezone: "UTC",
    bookingWindowDays: 30,
  };
  const past = checkDateWithinBookingWindow(schedule, "2000-01-01", "Test Barber");
  assert.equal(past.ok, false);
  assert.equal(past.code, "past_date");

  const far = checkDateWithinBookingWindow(schedule, "2099-01-01", "Test Barber");
  assert.equal(far.ok, false);
  assert.equal(far.code, "outside_window");
});
