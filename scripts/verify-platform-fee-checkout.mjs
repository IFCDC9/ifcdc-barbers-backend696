#!/usr/bin/env node
/** Validates deposit checkout includes $0.99 platform fee in client math. */
import { computeChargeBreakdown, normalizeCheckoutBreakdown } from "../client/src/lib/stylePricing.js";

const deposit = computeChargeBreakdown(25, "deposit", {}, null);
if (deposit.platformFee !== 0.99) {
  console.error("FAIL deposit platformFee", deposit.platformFee);
  process.exit(1);
}
if (deposit.paypalTotal !== deposit.serviceCharge + 0.99) {
  console.error("FAIL deposit paypalTotal", deposit.paypalTotal, "expected", deposit.serviceCharge + 0.99);
  process.exit(1);
}

const stale = normalizeCheckoutBreakdown(
  { totalPrice: 25, depositAmount: 10, serviceCharge: 10, platformFee: 0, tipAmount: 0, paypalTotal: 10 },
  null,
);
if (stale.platformFee !== 0.99 || stale.paypalTotal !== 10.99) {
  console.error("FAIL normalize stale quote", stale);
  process.exit(1);
}

console.log("OK platform fee checkout:", {
  depositPayNow: deposit.paypalTotal,
  platformFee: deposit.platformFee,
  normalizedStale: stale.paypalTotal,
});
