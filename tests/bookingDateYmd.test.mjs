import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { bookingDateToYmd } = require("../bookingDateYmd.cjs");

test("bookingDateToYmd from Date uses UTC calendar day", () => {
  // Postgres DATE often arrives as UTC midnight for that calendar day
  const d = new Date("2026-07-14T04:00:00.000Z");
  assert.equal(bookingDateToYmd(d), "2026-07-14");
});

test("bookingDateToYmd from ISO string", () => {
  assert.equal(bookingDateToYmd("2026-07-14T04:00:00.000Z"), "2026-07-14");
  assert.equal(bookingDateToYmd("2026-07-14"), "2026-07-14");
});

test("String(date).slice(0,10) is unsafe for Date objects", () => {
  const d = new Date("2026-07-14T04:00:00.000Z");
  const unsafe = String(d).slice(0, 10);
  assert.notEqual(unsafe, "2026-07-14");
  assert.equal(bookingDateToYmd(d), "2026-07-14");
});

test("empty / invalid returns empty string", () => {
  assert.equal(bookingDateToYmd(null), "");
  assert.equal(bookingDateToYmd(""), "");
  assert.equal(bookingDateToYmd("not-a-date"), "");
});
