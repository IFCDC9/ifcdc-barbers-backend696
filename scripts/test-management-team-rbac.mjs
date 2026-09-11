#!/usr/bin/env node
/**
 * Management Team RBAC / security tests (unit + optional live DB).
 *
 *   node --import ./loadBackendEnv.mjs scripts/test-management-team-rbac.mjs
 */
import assert from "node:assert/strict";
import {
  MANAGEMENT_PERMISSIONS,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  expandEffectivePermissions,
  hasEffectivePermission,
  isValidManagementRole,
} from "../managementPermissions.js";
import { assertShopInManagementScope, validateAssignmentPayload } from "../managementTeamAuth.js";
import { ensureManagementTeamSchema } from "../managementTeamMigrations.js";

console.log("[mt] permission catalog");
assert.ok(isValidManagementRole("platform_manager"));
assert.ok(isValidManagementRole("shop_manager"));
assert.ok(isValidManagementRole("location_manager"));
assert.equal(isValidManagementRole("super_admin"), false);

const full = expandEffectivePermissions({ [MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS]: true });
assert.equal(full.manage_staff, true);
assert.equal(full.manage_pricing, true);
assert.equal(full.full_manager_access, true);
for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
  assert.equal(full[cap], undefined);
  assert.equal(hasEffectivePermission(full, cap), false);
}
console.log("[mt] PASS — Full Manager Access expands scoped perms only");

const partial = expandEffectivePermissions({ manage_staff: true, manage_pricing: false });
assert.equal(partial.manage_staff, true);
assert.equal(partial.manage_pricing, false);
assert.equal(hasEffectivePermission(partial, "manage_staff"), true);
assert.equal(hasEffectivePermission(partial, "manage_pricing"), false);
console.log("[mt] PASS — individual permission switches");

const badLoc = validateAssignmentPayload({
  role: "location_manager",
  shopIds: [1],
  locationIds: [],
});
assert.equal(badLoc.ok, false);
const okShop = validateAssignmentPayload({
  role: "shop_manager",
  shopIds: [10, 20],
  locationIds: [],
  permissions: { manage_staff: true },
});
assert.equal(okShop.ok, true);
assert.deepEqual(okShop.shopIds, [10, 20]);
console.log("[mt] PASS — assignment validation");

assert.equal(assertShopInManagementScope({ all: true }, 99), true);
assert.equal(assertShopInManagementScope({ all: false, businessIds: [1, 2] }, 2), true);
assert.equal(assertShopInManagementScope({ all: false, businessIds: [1, 2] }, 9), false);
assert.equal(assertShopInManagementScope({ all: false, businessId: 5 }, 5), true);
assert.equal(assertShopInManagementScope({ all: false, businessId: 5 }, 6), false);
console.log("[mt] PASS — shop scope enforcement helper");

if (!process.env.DATABASE_URL?.trim()) {
  console.log(JSON.stringify({ liveDb: "skipped", reason: "no_DATABASE_URL" }));
  process.exit(0);
}

try {
  const migrated = await ensureManagementTeamSchema();
  assert.ok(migrated?.ok);
  console.log("[mt] PASS — schema migration idempotent");
} catch (e) {
  console.error("[mt] FAIL schema:", e?.message || e);
  process.exit(1);
}

// Import service after schema so tables exist
const {
  createManagementAssignment,
  setManagementAssignmentStatus,
  listManagementTeam,
} = await import("../managementTeamService.js");
const { loadActiveManagementContext } = await import("../managementTeamAuth.js");
const { dbQuery } = await import("../db.js");

const stamp = Date.now();
const emailA = `mgr.a.${stamp}@example.com`;
const emailB = `mgr.b.${stamp}@example.com`;

const shops = await dbQuery(`SELECT id FROM businesses ORDER BY id ASC LIMIT 2`);
const shopRows = shops.rows || [];
if (shopRows.length < 1) {
  console.log(JSON.stringify({ liveDb: "partial", reason: "need_at_least_one_business" }));
  process.exit(0);
}
const shop1 = Number(shopRows[0].id);
const shop2 = shopRows[1] ? Number(shopRows[1].id) : shop1;

const actor = await dbQuery(
  `SELECT id, email FROM app_users WHERE lower(role)='super_admin' OR lower(email)='service@ifcdc.org' LIMIT 1`,
);
const actorId = actor.rows?.[0]?.id || null;
const actorEmail = actor.rows?.[0]?.email || "service@ifcdc.org";

const a = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  email: emailA,
  name: "Manager A",
  createIfMissing: true,
  role: "shop_manager",
  shopIds: [shop1],
  locationIds: [],
  permissions: { manage_staff: true, manage_appointments: true },
  fullAccess: false,
});
assert.equal(a.ok, true, a.message);
assert.ok(a.assignment?.id);

const b = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  email: emailB,
  name: "Manager B",
  createIfMissing: true,
  role: "platform_manager",
  shopIds: shop2 !== shop1 ? [shop1, shop2] : [shop1],
  locationIds: [],
  permissions: {},
  fullAccess: true,
});
assert.equal(b.ok, true, b.message);

const team = await listManagementTeam();
assert.ok(team.some((m) => m.id === a.assignment.id));
assert.ok(team.some((m) => m.id === b.assignment.id));
console.log("[mt] PASS — multiple managers coexist");

const ctxA = await loadActiveManagementContext(a.assignment.userId);
assert.ok(ctxA);
assert.deepEqual(ctxA.shopIds, [shop1]);
assert.equal(ctxA.permissions.manage_staff, true);
assert.equal(ctxA.permissions.manage_pricing, false);

const ctxB = await loadActiveManagementContext(b.assignment.userId);
assert.ok(ctxB.permissions.manage_pricing, true);
assert.ok(ctxB.shopIds.includes(shop1));
console.log("[mt] PASS — multi-shop + scoped permissions");

if (shop2 !== shop1) {
  assert.equal(assertShopInManagementScope({ all: false, businessIds: ctxA.shopIds }, shop2), false);
  console.log("[mt] PASS — cross-shop access denied for Manager A");
}

const rem = await setManagementAssignmentStatus({
  assignmentId: a.assignment.id,
  status: "removed",
  actorUserId: actorId,
  actorEmail,
});
assert.equal(rem.ok, true);
const ctxGone = await loadActiveManagementContext(a.assignment.userId);
assert.equal(ctxGone, null);
console.log("[mt] PASS — remove management access clears elevated context");

// Super Admin cannot be assigned
const saBlock = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  email: "service@ifcdc.org",
  createIfMissing: false,
  role: "shop_manager",
  shopIds: [shop1],
  locationIds: [],
  permissions: { manage_staff: true },
});
assert.equal(saBlock.ok, false);
console.log("[mt] PASS — cannot assign Super Admin as manager");

console.log("[mt] ALL PASS");
process.exit(0);
