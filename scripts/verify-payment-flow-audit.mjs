#!/usr/bin/env node
/**
 * Payment flow audit — full payment + platform fee only (no deposits).
 */
import {
  computeChargeBreakdown,
  enforcePlatformFeeOnBreakdown,
  resolvePlatformFeeUsd,
  depositsAllowedForBooking,
} from "../styleBookingPricing.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeSettlementFromCapture } = require("../bookingPaymentSettlement.cjs");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

assert(depositsAllowedForBooking() === false, "deposits must be disabled");
assert(resolvePlatformFeeUsd(0) === 0.99, "platform fee");

const full25 = computeChargeBreakdown(25, "deposit", {}, { platformFeeUsd: 0 });
assert(full25.platformFee === 0.99, "fee on full");
assert(full25.paypalTotal === 25.99, "total");
assert(full25.depositAmount === 0, "no deposit amount");
assert(full25.paymentType === "full", "payment type full");

const stale = enforcePlatformFeeOnBreakdown(
  { totalPrice: 25, depositAmount: 10, serviceCharge: 10, platformFee: 0, paypalTotal: 10, paymentType: "deposit" },
  {},
);
assert(stale.paypalTotal === 25.99, "stale normalized to full+fee");

const reject25 = computeSettlementFromCapture({
  servicePrice: 25,
  platformFee: 0,
  tipAmount: 0,
  capturedUsd: 25,
  captureId: "CAP_TEST",
  paymentProvider: "paypal",
});
assert(reject25.ok === false, "reject underpay");

const accept = computeSettlementFromCapture({
  servicePrice: 25,
  platformFee: 0.99,
  tipAmount: 0,
  capturedUsd: 25.99,
  captureId: "CAP_OK",
  paymentProvider: "paypal",
});
assert(accept.ok === true, "accept full pay");
assert(accept.paymentStatus === "paid_in_full", "status paid_in_full");
assert(accept.balanceDue === 0, "no balance");

console.log("OK payment flow audit (full pay only):", {
  paypalTotal: full25.paypalTotal,
  paymentStatus: accept.paymentStatus,
});
