#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isDeliverableCustomerEmail } = require("../bookingEmail.cjs");
const { paymentStatusForEmailFromRow, PAYMENT_STATUS } = require("../bookingPaymentSettlement.cjs");

const ok = isDeliverableCustomerEmail("user@example.com");
const bad = !isDeliverableCustomerEmail("pending+app@ifcdc.local");
const status = paymentStatusForEmailFromRow({
  payment_status: "paid_in_full",
  paypal_capture_id: "CAP1",
  amount_paid: 25.99,
  service_price: 25,
  platform_fee: 0.99,
});
if (!ok || !bad || status !== PAYMENT_STATUS.PAID_IN_FULL) {
  console.error("FAIL", { ok, bad, status });
  process.exit(1);
}
console.log("OK booking email gate");
