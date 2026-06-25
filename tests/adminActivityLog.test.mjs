import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_ACTIVITY, adminActivityLabel } from "../adminActivityLog.js";

test("admin activity labels cover onboarding events", () => {
  assert.equal(adminActivityLabel(ADMIN_ACTIVITY.SIGNUP_RECEIVED), "New signup received");
  assert.equal(adminActivityLabel(ADMIN_ACTIVITY.BARBER_APPROVED), "Barber approved");
  assert.equal(adminActivityLabel(ADMIN_ACTIVITY.SHOP_OWNER_APPROVED), "Shop owner approved");
  assert.equal(adminActivityLabel(ADMIN_ACTIVITY.ACCOUNT_DENIED), "Account denied");
});

test("approval email service exports", async () => {
  const mod = await import("../approvalEmailService.js");
  assert.equal(typeof mod.emailSuperAdminNewSignupPending, "function");
  assert.equal(typeof mod.emailUserAccountApproved, "function");
  assert.equal(typeof mod.emailUserAccountDenied, "function");
});
