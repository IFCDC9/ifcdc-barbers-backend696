import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtClaimsFromAppUser, publicUserFromAppUser } from "../authPlatformJwt.js";
import {
  managementFieldsForPublicUser,
  sessionPublicUserFromDb,
} from "../managementTeamAuth.js";
import { SUPER_ADMIN_ONLY_CAPABILITIES, hasEffectivePermission } from "../managementPermissions.js";

test("JWT claims are identity-only and omit managementRole", () => {
  const claims = jwtClaimsFromAppUser({
    id: "d9f68399-601a-438a-a227-850912c75dd3",
    email: "laketa47@icloud.com",
    role: "user",
  });
  assert.equal(claims.role, "user");
  assert.equal(claims.isSuperAdmin, false);
  assert.equal(Object.prototype.hasOwnProperty.call(claims, "managementRole"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(claims, "isManager"), false);
});

test("/me session user uses current DB managementRole, not stale JWT claim", () => {
  const appUser = {
    id: "d9f68399-601a-438a-a227-850912c75dd3",
    email: "laketa47@icloud.com",
    role: "user",
    full_name: "Laketa",
  };
  const staleJwt = {
    id: appUser.id,
    role: "user",
    managementRole: "shop_manager",
    isManager: true,
  };
  const ctx = {
    assignmentId: "a904175f-1573-4306-b0fb-4a19ea0b3b5b",
    userId: appUser.id,
    role: "platform_manager",
    status: "active",
    fullAccess: true,
    shopIds: [1],
    locationIds: ["b67d1301-d799-4040-8113-f971c619a721"],
    permissions: { full_manager_access: true },
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
  assert.deepEqual(session.managementShopIds, [1]);
  assert.equal(session.fullManagerAccess, true);
  assert.notEqual(session.managementRole, staleJwt.managementRole);
});

test("inactive assignment clears manager flags even if JWT still says shop_manager", () => {
  const session = sessionPublicUserFromDb({
    appUser: { id: "u1", email: "a@b.c", role: "user" },
    managementCtx: {
      assignmentId: "x",
      userId: "u1",
      role: "shop_manager",
      status: "removed",
      fullAccess: false,
      shopIds: [1],
      locationIds: [],
      permissions: {},
    },
    jwtPayload: { managementRole: "shop_manager", isManager: true },
  });
  assert.equal(session.isManager, false);
  assert.equal(session.managementRole, null);
});

test("platform manager fields never include Super Admin capabilities", () => {
  const fields = managementFieldsForPublicUser({
    assignmentId: "a",
    userId: "u",
    role: "platform_manager",
    status: "active",
    fullAccess: true,
    shopIds: [1],
    locationIds: [],
    permissions: { full_manager_access: true },
  });
  const ctx = {
    status: "active",
    permissions: fields.managerPermissions,
    fullAccess: true,
    shopIds: [1],
  };
  for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
    assert.equal(hasEffectivePermission(ctx, cap), false, cap);
  }
});
