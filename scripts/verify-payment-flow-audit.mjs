#!/usr/bin/env node
/**
 * Payment flow audit checks — platform fee enforcement + settlement + email preconditions.
 * Run: node scripts/verify-payment-flow-audit.mjs
 */
import {
  computeChargeBreakdown,
  enforcePlatformFeeOnBreakdown,
  resolvePlatformFeeUsd,
} from "../styleBookingPricing.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeSettlementFromCapture,
  resolvePlatformFeeUsd: settlementResolveFee,
  DEFAULT_PLATFORM_FEE,
} = require("../bookingPaymentSettlement.cjs");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// --- Platform fee always $0.99 ---
assert(resolvePlatformFeeUsd(0) === 0.99, "resolvePlatformFeeUsd(0) must be 0.99");
assert(resolvePlatformFeeUsd(null) === 0.99, "resolvePlatformFeeUsd(null) must be 0.99");
assert(settlementResolveFee(0) === 0.99, "settlement resolvePlatformFeeUsd(0) must be 0.99");

const full25 = computeChargeBreakdown(25, "full", {}, { platformFeeUsd: 0 });
assert(full25.platformFee === 0.99, `full $25 platformFee ${full25.platformFee}`);
assert(full25.paypalTotal === 25.99, `full $25 paypalTotal ${full25.paypalTotal}`);

const deposit25 = computeChargeBreakdown(25, "deposit", {}, { platformFeeUsd: 0 });
assert(deposit25.platformFee === 0.99, `deposit platformFee ${deposit25.platformFee}`);
assert(
  deposit25.paypalTotal === deposit25.serviceCharge + 0.99,
  `deposit paypalTotal ${deposit25.paypalTotal}`,
);

const stale = enforcePlatformFeeOnBreakdown(
  { totalPrice: 25, depositAmount: 10, serviceCharge: 10, platformFee: 0, tipAmount: 0, paypalTotal: 10, paymentType: "deposit" },
  {},
);
assert(stale.platformFee === 0.99, `stale breakdown fee ${stale.platformFee}`);
assert(stale.paypalTotal === 10.99, `stale breakdown total ${stale.paypalTotal}`);

const fullTip = computeChargeBreakdown(25, "full", { tipAmount: 5 }, { platformFeeUsd: 0.99 });
assert(fullTip.paypalTotal === 30.99, `full+tip paypalTotal ${fullTip.paypalTotal}`);

// --- Settlement rejects fee-bypass captures ---
const reject25 = computeSettlementFromCapture({
  servicePrice: 25,
  depositAmount: 0,
  platformFee: 0,
  tipAmount: 0,
  capturedUsd: 25,
  captureId: "CAP_TEST_25",
  paymentProvider: "paypal",
});
assert(reject25.ok === false, "settlement must reject $25 capture for $25 service");
assert(reject25.error === "payment_mismatch", `expected payment_mismatch got ${reject25.error}`);

const accept2599 = computeSettlementFromCapture({
  servicePrice: 25,
  depositAmount: 0,
  platformFee: 0,
  tipAmount: 0,
  capturedUsd: 25.99,
  captureId: "CAP_TEST_2599",
  paymentProvider: "paypal",
});
assert(accept2599.ok === true, "settlement must accept $25.99 full capture");
assert(accept2599.paymentStatus === "paid_full", accept2599.paymentStatus);

const depositAccept = computeSettlementFromCapture({
  servicePrice: 25,
  depositAmount: 10,
  platformFee: 0,
  tipAmount: 0,
  capturedUsd: 10.99,
  captureId: "CAP_DEP_1099",
  paymentProvider: "paypal",
});
assert(depositAccept.ok === true, "deposit $10.99 must settle");
assert(depositAccept.paymentStatus === "deposit_paid", depositAccept.paymentStatus);

const depositReject = computeSettlementFromCapture({
  servicePrice: 25,
  depositAmount: 10,
  platformFee: 0,
  tipAmount: 0,
  capturedUsd: 10,
  captureId: "CAP_DEP_10",
  paymentProvider: "paypal",
});
assert(depositReject.ok === false, "deposit $10 without fee must fail");

// --- Mobile-style charge math ---
const mobileFull = 25 + DEFAULT_PLATFORM_FEE;
assert(Math.abs(mobileFull - 25.99) < 0.001, `mobile full ${mobileFull}`);

console.log("OK payment flow audit:", {
  fullPayPalTotal: full25.paypalTotal,
  depositPayPalTotal: deposit25.paypalTotal,
  fullWithTip: fullTip.paypalTotal,
  staleNormalized: stale.paypalTotal,
  settlementReject25: reject25.error,
  settlementAccept2599: accept2599.paymentStatus,
  depositAccept: depositAccept.paymentStatus,
});
