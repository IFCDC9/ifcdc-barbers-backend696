import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT,
  evaluateRewardForBooking,
} from "../loyaltyService.js";
import { calculateFinalBookingTotal } from "../client/src/lib/bookingPaymentTotals.js";

const require = createRequire(import.meta.url);
const { bookingPaymentViewFromRow } = require("../bookingPaymentSettlement.cjs");

const booking = {
  business_id: 10,
  barber_id: "barber-1",
  barber_name: "Tessa",
  service_price: 45,
  services_json: [
    { id: "cut-1", name: "Standard Haircut", price: 30 },
    { id: "beard-1", name: "Beard Trim", price: 15 },
  ],
};

assert.equal(LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT, 5);

assert.deepEqual(
  evaluateRewardForBooking(
    { reward_type: "discount_fixed", reward_value: 10, eligible_services: [], eligible_barbers: [] },
    booking,
  ),
  { ok: true, discountAmount: 10 },
);

assert.deepEqual(
  evaluateRewardForBooking(
    {
      reward_type: "free_service",
      reward_value: 0,
      eligible_services: ["Beard Trim"],
      eligible_barbers: ["barber-1"],
    },
    booking,
  ),
  { ok: true, discountAmount: 15 },
);

assert.deepEqual(
  evaluateRewardForBooking(
    {
      reward_type: "free_standard_haircut",
      reward_value: 0,
      eligible_services: ["Standard Haircut"],
      eligible_barbers: [],
    },
    booking,
  ),
  { ok: true, discountAmount: 30 },
);

assert.equal(
  evaluateRewardForBooking(
    {
      reward_type: "discount_fixed",
      reward_value: 20,
      eligible_services: ["Premium Service"],
      eligible_barbers: [],
    },
    booking,
  ).ok,
  false,
);

assert.equal(
  evaluateRewardForBooking(
    {
      business_id: 99,
      reward_type: "discount_fixed",
      reward_value: 10,
      eligible_services: [],
      eligible_barbers: [],
    },
    booking,
  ).ok,
  false,
);

assert.deepEqual(
  evaluateRewardForBooking(
    { reward_type: "discount_percent", reward_value: 50, eligible_services: [], eligible_barbers: [] },
    booking,
  ),
  { ok: true, discountAmount: 22.5 },
);

const discountedPayment = bookingPaymentViewFromRow({
  service_price: 40,
  platform_fee: 0.99,
  total_amount: 30.99,
  amount_paid: 30.99,
  payment_status: "paid_in_full",
  paypal_capture_id: "CAPTURE-REWARD",
});
assert.equal(discountedPayment.isPaidInFull, true);

assert.deepEqual(
  calculateFinalBookingTotal({
    haircutPrice: 40,
    discountAmount: 10,
    tipAmount: 6,
  }),
  {
    haircutPrice: 40,
    depositAmount: 0,
    platformFee: 0.99,
    discountAmount: 10,
    tipAmount: 6,
    total: 36.99,
    remainingBalance: 0,
  },
);

console.log("loyaltyEngine tests passed");
