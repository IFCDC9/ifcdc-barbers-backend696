import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isQaTestLabel,
  isQaTestEmail,
  bookableBarberWhereSql,
  qaTestAccountExcludeSql,
  platformHouseBarberSql,
} = require("../barberBookingPolicy.cjs");

test("isQaTestLabel flags release, verify, and demo names", () => {
  assert.equal(isQaTestLabel("Release Test Barber"), true);
  assert.equal(isQaTestLabel("RV Test Barber"), true);
  assert.equal(isQaTestLabel("RV Reject Barber"), true);
  assert.equal(isQaTestLabel("Verify Barber"), true);
  assert.equal(isQaTestLabel("Verify Barber Shop"), true);
  assert.equal(isQaTestLabel("Demo Stylist"), true);
  assert.equal(isQaTestLabel("Clipper King"), false);
  assert.equal(isQaTestLabel("IFCDC Barbers"), false);
  assert.equal(isQaTestLabel("Laketa Johnson"), false);
});

test("isQaTestEmail flags QA and verify signup emails", () => {
  assert.equal(isQaTestEmail("rv-barber-123@gmail.com"), true);
  assert.equal(isQaTestEmail("release-owner-1@test.com"), true);
  assert.equal(isQaTestEmail("verify-barber-1782303032@gmail.com"), true);
  assert.equal(isQaTestEmail("verify-barber@pipeline-test.ifcdc.local"), true);
  assert.equal(isQaTestEmail("barber@realshop.com"), false);
});

test("bookableBarberWhereSql requires Super Admin approval and real shop or platform house", () => {
  const sql = bookableBarberWhereSql({ channel: "mobile" });
  assert.match(sql, /verification_status.*approved/i);
  assert.match(sql, /booking_hidden.*false/i);
  assert.match(sql, /role.*barber/i);
  assert.match(sql, /release test/);
  assert.match(sql, /%verify%/);
  assert.match(sql, /ifcdc barbers/);
  assert.match(sql, /business_id.*default/i);
  // Legacy business_id "0" must not cast to businesses.id=0 (no such shop).
  assert.match(sql, /\^\[1-9\]\[0-9\]\*/);
  // Orphan approved rows without a real shop must not pass via user_id IS NULL alone.
  assert.doesNotMatch(sql, /user_id IS NULL/);
});

test("platformHouseBarberSql recognizes IFCDC house provider", () => {
  const sql = platformHouseBarberSql("b");
  assert.match(sql, /ifcdc barbers/);
  assert.match(sql, /default/);
});

test("qaTestAccountExcludeSql blocks Verify Barber patterns", () => {
  const sql = qaTestAccountExcludeSql("b");
  assert.match(sql, /%verify%/);
  assert.match(sql, /verify-%/);
});
