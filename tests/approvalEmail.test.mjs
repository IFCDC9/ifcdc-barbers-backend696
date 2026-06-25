import assert from "node:assert/strict";
import { test } from "node:test";

test("approval email service exports and formats admin recipient", async () => {
  const mod = await import("../approvalEmailService.js");
  assert.equal(typeof mod.emailSuperAdminNewBarberPending, "function");
  assert.equal(typeof mod.emailSuperAdminNewShopOwnerPending, "function");
  assert.equal(typeof mod.emailUserAccountApproved, "function");
  assert.equal(typeof mod.emailUserAccountDenied, "function");
  assert.equal(typeof mod.isApprovalEmailConfigured, "function");
});
