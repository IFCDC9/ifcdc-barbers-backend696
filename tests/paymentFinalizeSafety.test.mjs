import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("EditBarberScheduleScreen imports WEEKDAYS", () => {
  const src = fs.readFileSync(
    path.join(root, "mobile/screens/schedule/EditBarberScheduleScreen.tsx"),
    "utf8",
  );
  assert.match(src, /import\s*\{\s*WEEKDAYS\s*\}\s*from\s*["'].*scheduleDays["']/);
  assert.match(src, /WEEKDAYS\.find/);
  assert.match(src, /WEEKDAYS\.map/);
});

test("finalize validates slot before PayPal capture", () => {
  const src = fs.readFileSync(path.join(root, "appBookingCheckoutRoutes.cjs"), "utf8");
  const preIdx = src.indexOf("blocked BEFORE capture");
  const captureIdx = src.indexOf("captureOrGetCompletedPayPalOrder(client, orderID)");
  assert.ok(preIdx > 0, "pre-capture block path missing");
  assert.ok(captureIdx > preIdx, "capture must run after pre-capture validation");
  assert.match(src, /bookingDateToYmd/);
  assert.match(src, /refundCapturedBookingOrAlert/);
});

test("orphan payment refund helper exists", () => {
  const src = fs.readFileSync(path.join(root, "orphanPaymentRefund.cjs"), "utf8");
  assert.match(src, /refundPayPalCapture/);
  assert.match(src, /payment_status = 'refunded'/);
});
