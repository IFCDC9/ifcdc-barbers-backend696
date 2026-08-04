/**
 * Unit tests for SMS foundation (no live Twilio calls).
 */
import assert from "node:assert/strict";
import { createRequire } from "module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { normalizeToE164, maskPhoneForDisplay } = require("../smsPhone.cjs");
const { smsFlags, isSmsNotificationsEnabled, isSmsVerifyEnabled } = require("../smsFlags.cjs");
const {
  mapPaypalEventToCategory,
  buildPaymentSmsBody,
} = require("../smsPaymentNotify.cjs");
const { buildBookingSmsBody, shortRef } = require("../smsBookingNotify.cjs");
const { assertQueueableEmailKind } = require("../pendingEmailDelivery.cjs");

test("normalizeToE164 accepts +E.164 and US 10-digit", () => {
  assert.equal(normalizeToE164("+15551234567").ok, true);
  assert.equal(normalizeToE164("+15551234567").e164, "+15551234567");
  assert.equal(normalizeToE164("(555) 123-4567").e164, "+15551234567");
  assert.equal(normalizeToE164("").ok, false);
  assert.equal(maskPhoneForDisplay("+15551234567").endsWith("4567"), true);
});

test("SMS flags default off (safe for production)", () => {
  const prevN = process.env.SMS_NOTIFICATIONS_ENABLED;
  const prevV = process.env.SMS_VERIFY_ENABLED;
  delete process.env.SMS_NOTIFICATIONS_ENABLED;
  delete process.env.SMS_VERIFY_ENABLED;
  assert.equal(isSmsNotificationsEnabled(), false);
  assert.equal(isSmsVerifyEnabled(), false);
  assert.equal(smsFlags().notificationsEnabled, false);
  if (prevN !== undefined) process.env.SMS_NOTIFICATIONS_ENABLED = prevN;
  if (prevV !== undefined) process.env.SMS_VERIFY_ENABLED = prevV;
});

test("PayPal event mapping for payment SMS categories", () => {
  assert.equal(mapPaypalEventToCategory("PAYMENT.CAPTURE.COMPLETED"), "payment_success");
  assert.equal(mapPaypalEventToCategory("PAYMENT.CAPTURE.DENIED"), "payment_denied");
  assert.equal(mapPaypalEventToCategory("PAYMENT.CAPTURE.REFUNDED"), "payment_refunded");
  assert.equal(mapPaypalEventToCategory("PAYMENT.CAPTURE.REVERSED"), "payment_reversed");
  assert.equal(mapPaypalEventToCategory("CHECKOUT.ORDER.APPROVED"), null);
});

test("payment SMS body has amount + ref but no card/paypal account numbers", () => {
  const body = buildPaymentSmsBody("payment_success", {
    amount: "35.99",
    currency: "USD",
    bookingId: "3fbbf6ea-9ada-404a-9b1e-700da37b7264",
    captureId: "64L950419V2825032",
  });
  assert.match(body, /35\.99/);
  assert.match(body, /3FBBF6EA/i);
  assert.doesNotMatch(body, /64L950419V2825032/);
  assert.doesNotMatch(body, /card/i);
});

test("booking SMS body includes barber service when/ref without payment secrets", () => {
  const body = buildBookingSmsBody("booking_approved", {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    barber_name: "IFCDC Barbers",
    service: "Taper",
    date: "2026-08-06",
    time: "13:30",
    location: "HQ",
  });
  assert.match(body, /Taper/);
  assert.match(body, /IFCDC Barbers/);
  assert.match(body, /2026-08-06/);
  assert.match(body, /13:30/);
  assert.match(body, /AAAAAAAA/i);
  assert.equal(shortRef("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "AAAAAAAA");
});

test("pending email queue still rejects OTP/login kinds", () => {
  assert.equal(assertQueueableEmailKind("booking_confirmation").ok, true);
  assert.equal(assertQueueableEmailKind("login_otp").ok, false);
  assert.equal(assertQueueableEmailKind("auth_verification_code").ok, false);
});
