import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseSpokenDateToYmd,
  parseSpokenTimeToSlotLabel,
  speakSlotList,
  failFinalizeReply,
  shopTimezone,
} = require("../auraVoiceIntelligenceBooking.cjs");

test("shop timezone defaults to America/New_York", () => {
  assert.equal(shopTimezone(), "America/New_York");
});

test("spoken dates resolve in America/New_York", async () => {
  const tz = "America/New_York";
  const tomorrow = await parseSpokenDateToYmd("tomorrow afternoon", tz);
  assert.match(tomorrow, /^\d{4}-\d{2}-\d{2}$/);
  const friday = await parseSpokenDateToYmd("Friday at 2:30", tz);
  assert.match(friday, /^\d{4}-\d{2}-\d{2}$/);
  const sat = await parseSpokenDateToYmd("next Saturday morning", tz);
  assert.match(sat, /^\d{4}-\d{2}-\d{2}$/);
});

test("spoken times become AM/PM slot labels", async () => {
  assert.equal(await parseSpokenTimeToSlotLabel("2:30 pm"), "02:30 PM");
  assert.equal(await parseSpokenTimeToSlotLabel("14:00"), "02:00 PM");
  assert.equal(await parseSpokenTimeToSlotLabel("tomorrow afternoon", { periodHint: "afternoon" }), "02:00 PM");
  assert.equal(await parseSpokenTimeToSlotLabel("morning"), "10:00 AM");
});

test("fail finalize reply is explicit", () => {
  assert.match(failFinalizeReply(), /have not charged you or confirmed/i);
});

test("speakSlotList formats open times", () => {
  assert.match(speakSlotList(["10:00 AM", "11:00 AM", "02:00 PM"]), /10:00 AM/);
});
