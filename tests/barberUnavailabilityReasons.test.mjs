import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClientUnavailability,
  DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE,
  normalizeClientReason,
  sanitizeClientMessage,
} from "../barberUnavailabilityReasons.js";

test("default message when no reason set", () => {
  const out = buildClientUnavailability(null);
  assert.equal(out.message, DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE);
});

test("day off message", () => {
  const out = buildClientUnavailability({ client_reason: "day_off" });
  assert.match(out.message, /off today/i);
});

test("vacation with return date", () => {
  const out = buildClientUnavailability({
    client_reason: "vacation",
    return_date: "2026-07-18",
  });
  assert.match(out.message, /vacation/i);
  assert.match(out.message, /July 18, 2026/);
});

test("custom client message", () => {
  const out = buildClientUnavailability({
    client_reason: "custom",
    client_message: "Back next week — thanks for your patience!",
  });
  assert.equal(out.message, "Back next week — thanks for your patience!");
});

test("private note is never included", () => {
  const out = buildClientUnavailability({
    client_reason: "day_off",
    note: "Doctor appointment — do not share",
  });
  assert.doesNotMatch(out.message, /doctor/i);
});

test("invalid reason falls back to default", () => {
  assert.equal(normalizeClientReason("not_a_real_reason"), null);
  const out = buildClientUnavailability({ client_reason: "not_a_real_reason" });
  assert.equal(out.message, DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE);
});

test("custom without message uses default", () => {
  const out = buildClientUnavailability({ client_reason: "custom", client_message: "" });
  assert.equal(out.message, DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE);
});

test("sanitizeClientMessage trims and caps length", () => {
  const long = "x".repeat(400);
  assert.equal(sanitizeClientMessage(long)?.length, 280);
});
