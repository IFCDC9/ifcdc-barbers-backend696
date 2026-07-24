import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isQaTestLabel,
  isQaTestEmail,
  bookableBarberWhereSql,
  qaTestAccountExcludeSql,
} = require("../barberBookingPolicy.cjs");

test("isQaTestLabel flags release and RV validation names", () => {
  assert.equal(isQaTestLabel("Release Test Barber"), true);
  assert.equal(isQaTestLabel("RV Test Barber"), true);
  assert.equal(isQaTestLabel("RV Reject Barber"), true);
  assert.equal(isQaTestLabel("Clipper King"), false);
});

test("isQaTestEmail flags QA signup emails", () => {
  assert.equal(isQaTestEmail("rv-barber-123@gmail.com"), true);
  assert.equal(isQaTestEmail("release-owner-1@test.com"), true);
  assert.equal(isQaTestEmail("barber@realshop.com"), false);
});

test("bookableBarberWhereSql requires approved active barber role", () => {
  const sql = bookableBarberWhereSql({ channel: "mobile" });
  assert.match(sql, /verification_status.*approved/i);
  assert.match(sql, /booking_hidden.*false/i);
  assert.match(sql, /role.*barber/i);
  assert.match(sql, /release test/);
  // Legacy business_id "0" must not cast to businesses.id=0 (no such shop).
  assert.match(sql, /\^\[1-9\]\[0-9\]\*/);
});
