import test from "node:test";
import assert from "node:assert/strict";
import {
  blockedSlotStartsForBooking,
  buildScheduleSlotMinutes,
  demoFallbackSchedule,
  minutesToSlotLabel,
  resolveBookingDateLabelToYmd,
  serviceDurationFitsSchedule,
  slotBlockingWhereSql,
  todayYmdInTimezone,
} from "../barberSlotEngine.js";

test("blocked dates return no slot minutes", () => {
  const schedule = {
    ...demoFallbackSchedule(),
    blockedDates: ["2026-06-01"],
  };
  assert.equal(buildScheduleSlotMinutes(schedule, "2026-06-01").length, 0);
});

test("demo fallback respects blocked dates on the schedule object", () => {
  const fallback = { ...demoFallbackSchedule(), blockedDates: ["2026-06-02"] };
  assert.equal(buildScheduleSlotMinutes(fallback, "2026-06-02").length, 0);
  assert.ok(buildScheduleSlotMinutes(fallback, "2026-06-03").length > 0);
});

test("open days still produce slots when not blocked", () => {
  const schedule = demoFallbackSchedule();
  const minutes = buildScheduleSlotMinutes(schedule, "2026-06-04");
  assert.ok(minutes.length > 0);
});

test("slotBlockingWhereSql excludes declined/cancelled and uses AT TIME ZONE", () => {
  const sql = slotBlockingWhereSql("'$1'", "'America/New_York'");
  assert.match(sql, /declined/);
  assert.match(sql, /AT TIME ZONE/);
  assert.match(sql, /paid_in_full/);
  assert.match(sql, /pending_payment/);
});

test("60-minute service does not fit in a 30-minute remaining window", () => {
  const schedule = {
    ...demoFallbackSchedule(),
    availability: [{ day_of_week: 1, start_time: "09:00:00", end_time: "11:00:00", is_off: false }],
    timezone: "America/New_York",
  };
  // Monday 2026-06-01
  assert.equal(serviceDurationFitsSchedule(schedule, "2026-06-01", 10 * 60 + 30, 60), false);
  assert.equal(serviceDurationFitsSchedule(schedule, "2026-06-01", 9 * 60, 60), true);
});

test("blockedSlotStartsForBooking covers consecutive intervals for long services", () => {
  assert.deepEqual(blockedSlotStartsForBooking(10 * 60, 60, 30), [600, 630]);
});

test("minutesToSlotLabel is 12-hour AM/PM", () => {
  assert.equal(minutesToSlotLabel(9 * 60), "09:00 AM");
  assert.equal(minutesToSlotLabel(13 * 60 + 30), "01:30 PM");
});

test("resolveBookingDateLabelToYmd Today uses barber timezone", () => {
  const todayEt = todayYmdInTimezone("America/New_York");
  assert.equal(resolveBookingDateLabelToYmd("Today", "America/New_York"), todayEt);
  assert.equal(resolveBookingDateLabelToYmd("2026-07-22", "America/New_York"), "2026-07-22");
});
