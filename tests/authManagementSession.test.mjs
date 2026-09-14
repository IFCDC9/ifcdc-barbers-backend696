import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtClaimsFromAppUser, publicUserFromAppUser } from "../authPlatformJwt.js";
import {
  managementFieldsForPublicUser,
  sessionPublicUserFromDb,
} from "../managementTeamAuth.js";
import { SUPER_ADMIN_ONLY_CAPABILITIES, hasEffectivePermission } from "../managementPermissions.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSIGNMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("JWT claims are identity-only and omit managementRole", () => {
  const claims = jwtClaimsFromAppUser({
    id: USER_ID,
    email: "manager.fixture@example.com",
    role: "user",
  });
  assert.equal(claims.role, "user");
  assert.equal(claims.isSuperAdmin, false);
  assert.equal(Object.prototype.hasOwnProperty.call(claims, "managementRole"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(claims, "isManager"), false);
});

test("/me session user uses current DB managementRole, not stale JWT claim", () => {
  const appUser = {
    id: USER_ID,
    email: "manager.fixture@example.com",
    role: "user",
    full_name: "Fixture Manager",
  };
  const staleJwt = {
    id: appUser.id,
    role: "user",
    managementRole: "shop_manager",
    isManager: true,
  };
  const ctx = {
    assignmentId: ASSIGNMENT_ID,
    userId: appUser.id,
    role: "platform_manager",
    status: "active",
    fullAccess: true,
    shopIds: [3, 7, 11],
    locationIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    permissions: { full_manager_access: true },
    updatedAt: "2026-09-14T12:00:00.000Z",
  };

  const fromJwtShape = publicUserFromAppUser(appUser);
  assert.equal(fromJwtShape.managementRole, undefined);

  const session = sessionPublicUserFromDb({
    appUser,
    managementCtx: ctx,
    jwtPayload: staleJwt,
  });
  assert.equal(session.role, "user");
  assert.equal(session.isSuperAdmin, false);
  assert.equal(session.isManager, true);
  assert.equal(session.managementRole, "platform_manager");
  assert.equal(session.managementStatus, "active");
  assert.deepEqual(session.managementShopIds, [3, 7, 11]);
  assert.equal(session.fullManagerAccess, true);
  assert.ok(session.managementVersion);
  assert.notEqual(session.managementRole, staleJwt.managementRole);
});

test("inactive assignment clears manager flags even if JWT still says shop_manager", () => {
  const session = sessionPublicUserFromDb({
    appUser: { id: USER_ID, email: "a@example.com", role: "user" },
    managementCtx: {
      assignmentId: ASSIGNMENT_ID,
      userId: USER_ID,
      role: "shop_manager",
      status: "removed",
      fullAccess: false,
      shopIds: [101],
      locationIds: [],
      permissions: {},
    },
    jwtPayload: { managementRole: "shop_manager", isManager: true },
  });
  assert.equal(session.isManager, false);
  assert.equal(session.managementRole, null);
  assert.equal(session.managementVersion, null);
});

test("platform manager fields never include Super Admin capabilities", () => {
  const fields = managementFieldsForPublicUser({
    assignmentId: ASSIGNMENT_ID,
    userId: USER_ID,
    role: "platform_manager",
    status: "active",
    fullAccess: true,
    shopIds: [3, 7],
    locationIds: [],
    permissions: { full_manager_access: true },
  });
  for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
    assert.equal(hasEffectivePermission(fields.managerPermissions, cap), false, cap);
  }
});
