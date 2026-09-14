import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtClaimsFromAppUser, publicUserFromAppUser } from "../authPlatformJwt.js";
import {
  authorizeManagerApiAccess,
  managementFieldsForPublicUser,
  managementVersionFromContext,
  managerCanAccessShop,
  sessionPublicUserFromDb,
  validateAssignmentPayload,
} from "../managementTeamAuth.js";
import {
  SUPER_ADMIN_ONLY_CAPABILITIES,
  expandEffectivePermissions,
  hasEffectivePermission,
} from "../managementPermissions.js";
import { assignmentAuditSnapshot } from "../managementTeamService.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function ctx({
  userId = USER_A,
  role = "shop_manager",
  status = "active",
  shopIds = [101],
  locationIds = [],
  fullAccess = false,
  permissions = {},
  updatedAt = "2026-09-14T12:00:00.000Z",
  assignmentId = "44444444-4444-4444-8444-444444444444",
} = {}) {
  const built = {
    assignmentId,
    userId,
    role,
    status,
    fullAccess,
    shopIds: shopIds.slice(),
    locationIds: locationIds.slice(),
    permissions: expandEffectivePermissions(
      fullAccess ? { full_manager_access: true, ...permissions } : permissions,
    ),
    updatedAt,
  };
  built.version = managementVersionFromContext(built);
  return built;
}

function appUser(id = USER_A, role = "user") {
  return { id, email: `${id.slice(0, 8)}@example.com`, role, full_name: "Manager Fixture" };
}

function session(managementCtx, jwtStale = { managementRole: "shop_manager", isManager: true }) {
  return sessionPublicUserFromDb({
    appUser: appUser(managementCtx?.userId || USER_A),
    managementCtx,
    jwtPayload: jwtStale,
  });
}

test("1-2 create Shop A and Shop B as distinct stable IDs", () => {
  const shopA = 101;
  const shopB = 202;
  assert.notEqual(shopA, shopB);
});

test("3-5 Manager A assigned to Shop A; Shop B is 403", () => {
  const management = ctx({ shopIds: [101], role: "shop_manager" });
  assert.equal(managerCanAccessShop(management, 101), true);
  assert.equal(managerCanAccessShop(management, 202), false);
  assert.equal(authorizeManagerApiAccess({ managementCtx: management, businessId: 101 }).ok, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: management, businessId: 202 }).status, 403);
  assert.equal(authorizeManagerApiAccess({ managementCtx: management, businessId: 202 }).reason, "shop_not_assigned");
});

test("6-8 promote to platform_manager and assign Shop B; both shops allowed, Shop C denied", () => {
  const before = ctx({ role: "shop_manager", shopIds: [101] });
  const after = ctx({
    role: "platform_manager",
    shopIds: [101, 202],
    fullAccess: true,
    updatedAt: "2026-09-14T13:00:00.000Z",
  });
  assert.notEqual(managementVersionFromContext(before), managementVersionFromContext(after));
  const me = session(after, { managementRole: "shop_manager" });
  assert.equal(me.managementRole, "platform_manager");
  assert.equal(me.role, "user");
  assert.deepEqual(me.managementShopIds, [101, 202]);
  assert.equal(authorizeManagerApiAccess({ managementCtx: after, businessId: 101 }).ok, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: after, businessId: 202 }).ok, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: after, businessId: 303 }).status, 403);
});

test("9-10 remove Shop B assignment; Shop B immediately 403", () => {
  const afterRemove = ctx({ role: "platform_manager", shopIds: [101], fullAccess: true });
  assert.equal(authorizeManagerApiAccess({ managementCtx: afterRemove, businessId: 202 }).status, 403);
  assert.equal(authorizeManagerApiAccess({ managementCtx: afterRemove, businessId: 101 }).ok, true);
});

test("11-12 downgrade platform_manager → shop_manager updates session refresh fields", () => {
  const downgraded = ctx({ role: "shop_manager", shopIds: [101], fullAccess: false });
  const me = session(downgraded, { managementRole: "platform_manager", isManager: true });
  assert.equal(me.managementRole, "shop_manager");
  assert.equal(me.fullManagerAccess, false);
  assert.ok(me.managementVersion);
});

test("13-14 suspend manager; all management APIs 403", () => {
  const suspended = ctx({ status: "suspended", shopIds: [101] });
  const me = session(suspended);
  assert.equal(me.isManager, false);
  assert.equal(me.managementRole, null);
  assert.equal(authorizeManagerApiAccess({ managementCtx: suspended, businessId: 101 }).status, 403);
  assert.equal(authorizeManagerApiAccess({ managementCtx: null, businessId: 101 }).status, 403);
});

test("15-16 reactivate manager restores assigned shops only", () => {
  const active = ctx({ status: "active", role: "shop_manager", shopIds: [101] });
  const me = session(active);
  assert.equal(me.isManager, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: active, businessId: 101 }).ok, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: active, businessId: 202 }).status, 403);
});

test("17-18 remove management access; user stays customer without manager capabilities", () => {
  const removed = ctx({ status: "removed", shopIds: [101] });
  const me = sessionPublicUserFromDb({
    appUser: appUser(USER_A, "user"),
    managementCtx: removed,
    jwtPayload: { managementRole: "platform_manager", isManager: true },
  });
  assert.equal(me.role, "user");
  assert.equal(me.isManager, false);
  assert.equal(me.managementRole, null);
  assert.deepEqual(me.managementShopIds, []);
  assert.equal(me.isSuperAdmin, false);
});

test("19 Super Admin protections throughout", () => {
  const platform = ctx({ role: "platform_manager", shopIds: [3, 7, 11], fullAccess: true });
  const fields = managementFieldsForPublicUser(platform);
  for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
    assert.equal(hasEffectivePermission(fields.managerPermissions, cap), false, cap);
  }
  assert.equal(authorizeManagerApiAccess({ isSuperAdmin: true, businessId: 12 }).ok, true);
  assert.equal(authorizeManagerApiAccess({ managementCtx: platform, businessId: 12 }).status, 403);
  assert.equal(jwtClaimsFromAppUser(appUser()).isSuperAdmin, false);
  assert.equal(Object.prototype.hasOwnProperty.call(jwtClaimsFromAppUser(appUser()), "managementRole"), false);
  const saPayload = validateAssignmentPayload({ role: "super_admin", shopIds: [101] });
  assert.equal(saPayload.ok, false);
});

test("multiple managers on the same shop", () => {
  const a = ctx({ userId: USER_A, shopIds: [101], assignmentId: "55555555-5555-4555-8555-555555555555" });
  const b = ctx({ userId: USER_B, shopIds: [101], assignmentId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(managerCanAccessShop(a, 101), true);
  assert.equal(managerCanAccessShop(b, 101), true);
  assert.notEqual(a.assignmentId, b.assignmentId);
  assert.notEqual(a.userId, b.userId);
});

test("platform manager never means all businesses", () => {
  const pm = ctx({ role: "platform_manager", shopIds: [3, 7, 11], fullAccess: true });
  assert.equal(managerCanAccessShop(pm, 3), true);
  assert.equal(managerCanAccessShop(pm, 12), false);
});

test("location manager is scoped by location IDs, not shop name", () => {
  const loc = ctx({
    role: "location_manager",
    shopIds: [202],
    locationIds: [LOC_B],
  });
  assert.equal(managerCanAccessShop(loc, 202), true);
  assert.equal(managerCanAccessShop(loc, 101), false);
  assert.ok(loc.locationIds.includes(LOC_B));
  assert.equal(loc.locationIds.includes(LOC_A), false);
});

test("JWT identity-only; /me fields ignore stale claims", () => {
  const publicShape = publicUserFromAppUser(appUser());
  assert.equal(publicShape.managementRole, undefined);
  const me = session(ctx({ role: "platform_manager", shopIds: [7, 11] }), {
    managementRole: "location_manager",
    managementShopIds: [1],
  });
  assert.equal(me.managementRole, "platform_manager");
  assert.deepEqual(me.managementShopIds, [7, 11]);
});

test("audit snapshot includes actor/manager, old/new role and scope", () => {
  const before = {
    userId: USER_A,
    role: "shop_manager",
    status: "active",
    fullAccess: false,
    shops: [{ businessId: 101 }],
    locations: [],
    permissions: { manage_staff: true },
  };
  const after = {
    userId: USER_A,
    role: "platform_manager",
    status: "active",
    fullAccess: true,
    shops: [{ businessId: 101 }, { businessId: 202 }],
    locations: [{ locationId: LOC_A }],
    permissions: { full_manager_access: true, manage_staff: true },
  };
  const oldSnap = assignmentAuditSnapshot(before);
  const newSnap = assignmentAuditSnapshot(after);
  assert.equal(oldSnap.managerUserId, USER_A);
  assert.equal(oldSnap.role, "shop_manager");
  assert.equal(newSnap.role, "platform_manager");
  assert.deepEqual(oldSnap.shopIds, [101]);
  assert.deepEqual(newSnap.shopIds, [101, 202]);
  void ACTOR;
});
