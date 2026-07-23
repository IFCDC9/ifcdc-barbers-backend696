import assert from "node:assert/strict";
import {
  BYPASS_PAYMENT_TYPES,
  isBypassPaymentType,
  requireSuperAdminActor,
  toSlotEngineTimeLabel,
} from "../manualBypassBookingService.js";
import { slotBlockingWhereSql } from "../barberSlotEngine.js";

assert.equal(isBypassPaymentType("complimentary"), true);
assert.equal(isBypassPaymentType("pay_at_shop"), true);
assert.equal(isBypassPaymentType("staff_training"), true);
assert.equal(isBypassPaymentType("paid_online"), true);
assert.equal(isBypassPaymentType("full"), false);

assert.equal(BYPASS_PAYMENT_TYPES.COMPLIMENTARY, "complimentary");
assert.equal(toSlotEngineTimeLabel("10:00"), "10:00 AM");
assert.equal(toSlotEngineTimeLabel("13:30"), "1:30 PM");
assert.equal(toSlotEngineTimeLabel("1:00 PM"), "1:00 PM");

const gateOk = requireSuperAdminActor({ user: { isSuperAdmin: true, email: "service@ifcdc.org" } });
assert.equal(gateOk.ok, true);

const gateOwner = requireSuperAdminActor({ user: { isOwner: true, role: "admin" } });
assert.equal(gateOwner.ok, true);

const gateAdmin = requireSuperAdminActor({ user: { role: "admin", isSuperAdmin: false } });
assert.equal(gateAdmin.ok, false);
assert.equal(gateAdmin.status, 403);

const gateShop = requireSuperAdminActor({ user: { role: "shop_owner" } });
assert.equal(gateShop.ok, false);

const sql = slotBlockingWhereSql("$4", "$5");
assert.match(sql, /manual_bypass/);
assert.match(sql, /pay_at_shop/);
assert.match(sql, /complimentary/);
assert.match(sql, /staff_training/);

console.log("manual bypass unit checks passed");
