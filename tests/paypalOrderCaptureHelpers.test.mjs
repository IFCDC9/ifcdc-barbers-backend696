import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parsePayPalSdkError,
  isPayPalOrderAlreadyCapturedError,
  extractCaptureIdFromOrder,
  extractOrderAmountUsd,
  extractOrderCurrency,
} = require("../paypalOrderCaptureHelpers.cjs");

const already = new Error(
  JSON.stringify({
    name: "UNPROCESSABLE_ENTITY",
    details: [{ issue: "ORDER_ALREADY_CAPTURED", description: "Order already captured" }],
    debug_id: "dbg-already",
  }),
);
already.statusCode = 422;
assert.equal(isPayPalOrderAlreadyCapturedError(already), true);
const parsed = parsePayPalSdkError(already);
assert.equal(parsed.debugId, "dbg-already");
assert.equal(parsed.issues[0], "ORDER_ALREADY_CAPTURED");

const notApproved = new Error(
  JSON.stringify({
    name: "UNPROCESSABLE_ENTITY",
    details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved" }],
    debug_id: "dbg-not-approved",
  }),
);
notApproved.statusCode = 422;
assert.equal(isPayPalOrderAlreadyCapturedError(notApproved), false);
assert.equal(parsePayPalSdkError(notApproved).issues[0], "ORDER_NOT_APPROVED");

const order = {
  status: "COMPLETED",
  purchase_units: [
    {
      amount: { currency_code: "USD", value: "25.99" },
      payments: { captures: [{ id: "CAP123", amount: { currency_code: "USD", value: "25.99" } }] },
    },
  ],
};
assert.equal(extractCaptureIdFromOrder(order), "CAP123");
assert.equal(extractOrderAmountUsd(order), 25.99);
assert.equal(extractOrderCurrency(order), "USD");

console.log("paypalOrderCaptureHelpers tests passed");
