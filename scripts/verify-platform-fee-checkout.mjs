#!/usr/bin/env node
/** Validates full checkout includes $0.99 platform fee (no deposits). */
import { computeChargeBreakdown, normalizeCheckoutBreakdown } from "../client/src/lib/stylePricing.js";

const full = computeChargeBreakdown(25, "full", {}, null);
if (full.platformFee !== 0.99) {
  console.error("FAIL full platformFee", full.platformFee);
  process.exit(1);
}
if (full.paypalTotal !== 25.99) {
  console.error("FAIL full paypalTotal", full.paypalTotal);
  process.exit(1);
}
if (full.depositAmount !== 0) {
  console.error("FAIL depositAmount should be 0", full.depositAmount);
  process.exit(1);
}

const stale = normalizeCheckoutBreakdown(
  { totalPrice: 25, depositAmount: 10, serviceCharge: 10, platformFee: 0, tipAmount: 0, paypalTotal: 10, paymentType: "deposit" },
  null,
);
if (stale.platformFee !== 0.99 || stale.paypalTotal !== 25.99) {
  console.error("FAIL normalize stale quote", stale);
  process.exit(1);
}

console.log("OK platform fee checkout (full pay only):", {
  paypalTotal: full.paypalTotal,
  platformFee: full.platformFee,
});
