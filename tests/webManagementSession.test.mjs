import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isActiveManager,
  managementRoleLabel,
  managementStateChanged,
  managementVersionOf,
  postLoginPath,
} from "../client/src/lib/staffDashboardAccess.js";

test("web helpers use /me management fields, not a hardcoded shop", () => {
  const manager = {
    role: "user",
    isManager: true,
    managementStatus: "active",
    managementRole: "platform_manager",
    managementVersion: "a|platform_manager|active|3,7,11||1|t",
  };
  assert.equal(isActiveManager(manager), true);
  assert.equal(managementRoleLabel(manager), "Platform Manager");
  assert.equal(postLoginPath(manager), "/admin/shops");
  assert.equal(isActiveManager({ ...manager, managementStatus: "suspended" }), false);
});

test("managementVersion change is detectable without app reinstall", () => {
  const prev = { managementVersion: "v1", managementRole: "shop_manager" };
  const next = { managementVersion: "v2", managementRole: "platform_manager" };
  assert.equal(managementStateChanged(prev, next), true);
  assert.equal(managementStateChanged(next, { ...next }), false);
  assert.equal(managementVersionOf(next), "v2");
});
