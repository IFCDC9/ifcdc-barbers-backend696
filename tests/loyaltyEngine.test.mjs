import assert from "node:assert/strict";
import {
  LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT,
  evaluateRewardForBooking,
} from "../loyaltyService.js";

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

console.log("loyaltyEngine tests passed");
