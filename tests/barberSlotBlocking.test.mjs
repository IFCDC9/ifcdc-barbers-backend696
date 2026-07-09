import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleSlotMinutes, demoFallbackSchedule } from "../barberSlotEngine.js";

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
