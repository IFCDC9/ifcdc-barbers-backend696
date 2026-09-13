#!/usr/bin/env node
/**
 * Multi-tenant Management Team isolation + future-manager onboarding regression.
 *
 * Creates Shop A / Shop B fixtures, managers, verifies:
 * - distinct roles (platform/shop/location)
 * - no Super Admin elevation
 * - cross-shop API scope returns false/403 helpers
 * - remove access clears privileges
 * - generic email→userId linkage (not Laketa-hardcoded)
 *
 *   node --import ./loadBackendEnv.mjs scripts/test-management-multitenant-isolation.mjs
 *   CLEANUP=1 node --import ./loadBackendEnv.mjs scripts/test-management-multitenant-isolation.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { dbQuery } from "../db.js";
import { ensureManagementTeamSchema } from "../managementTeamMigrations.js";
import {
  assertShopInManagementScope,
  ensureManagementLinkedToUser,
  loadActiveManagementContext,
  managementFieldsForPublicUser,
} from "../managementTeamAuth.js";
import {
  createManagementAssignment,
  setManagementAssignmentStatus,
  listManagementTeam,
} from "../managementTeamService.js";
import {
  MANAGEMENT_PERMISSIONS,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  expandEffectivePermissions,
  hasEffectivePermission,
} from "../managementPermissions.js";
import { hashPassword } from "../authPasswordPolicy.js";
import { isSuperAdminEmail } from "../rolePolicy.js";
import { deleteAppUserAccount } from "../accountDeletionService.js";

const stamp = Date.now();
const CLEANUP = String(process.env.CLEANUP || "1") !== "0";
const created = {
  businessIds: [],
  userIds: [],
  assignmentIds: [],
  locationIds: [],
};

await ensureManagementTeamSchema();

function email(tag) {
  return `mt.${tag}.${stamp}@example.com`;
}

async function createShop({ name, city, state }) {
  const r = await dbQuery(
    `INSERT INTO businesses (name, city, state, address, approval_status, account_status)
     VALUES ($1, $2, $3, $4, 'approved', 'active')
     RETURNING id, name, city, state`,
    [name, city, state, `${city} Main St`],
  );
  const row = r.rows[0];
  created.businessIds.push(Number(row.id));
  // ensure primary location
  const loc = await dbQuery(
    `INSERT INTO shop_locations (business_id, name, city, state, is_primary, status)
     VALUES ($1::bigint, $2, $3, $4, true, 'active')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [row.id, name, city, state],
  );
  let locationId = loc.rows?.[0]?.id;
  if (!locationId) {
    const existing = await dbQuery(
      `SELECT id FROM shop_locations WHERE business_id = $1::bigint AND is_primary = true LIMIT 1`,
      [row.id],
    );
    locationId = existing.rows?.[0]?.id;
  }
  if (locationId) created.locationIds.push(String(locationId));
  return { businessId: Number(row.id), locationId: String(locationId), name: row.name };
}

async function createCustomer(tag) {
  const plain = `Aa9!${crypto.randomBytes(8).toString("hex")}`;
  const hash = await hashPassword(plain);
  const em = email(tag);
  const r = await dbQuery(
    `INSERT INTO app_users (name, email, password_hash, role, account_status)
     VALUES ($1, $2, $3, 'user', 'active')
     RETURNING id, email, role`,
    [tag, em, hash],
  );
  created.userIds.push(String(r.rows[0].id));
  return { ...r.rows[0], password: plain };
}

const actor = await dbQuery(
  `SELECT id, email FROM app_users
   WHERE lower(role)='super_admin' OR lower(email)='service@ifcdc.org'
   LIMIT 1`,
);
const actorId = actor.rows?.[0]?.id || null;
const actorEmail = actor.rows?.[0]?.email || "service@ifcdc.org";

console.log("[mt-iso] creating Shop A / Shop B fixtures…");
const shopA = await createShop({ name: `IFCDC Barbers MT ${stamp}`, city: "Washington", state: "DC" });
const shopB = await createShop({ name: `Test Shop OtherState ${stamp}`, city: "Atlanta", state: "GA" });
assert.notEqual(shopA.businessId, shopB.businessId);

const mgrA = await createCustomer("managerA");
const mgrB = await createCustomer("managerB");
const locMgrB = await createCustomer("locMgrB");

// Future manager flow: assign by email to existing users (generic, not Laketa)
const assignA = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  userId: mgrA.id,
  role: "shop_manager",
  shopIds: [shopA.businessId],
  locationIds: [shopA.locationId],
  permissions: {},
  fullAccess: true,
});
assert.equal(assignA.ok, true, assignA.message);
created.assignmentIds.push(assignA.assignment.id);
assert.equal(assignA.assignment.role, "shop_manager");
assert.equal(assignA.assignment.user.role, "user");
assert.equal(assignA.assignment.fullAccess, true);

const assignB = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  email: mgrB.email,
  createIfMissing: false,
  role: "shop_manager",
  shopIds: [shopB.businessId],
  locationIds: [shopB.locationId],
  permissions: { manage_staff: true, manage_appointments: true, view_reports: true },
  fullAccess: false,
});
assert.equal(assignB.ok, true, assignB.message);
created.assignmentIds.push(assignB.assignment.id);

const assignLocB = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  userId: locMgrB.id,
  role: "location_manager",
  shopIds: [shopB.businessId],
  locationIds: [shopB.locationId],
  permissions: { manage_schedules: true },
  fullAccess: false,
});
assert.equal(assignLocB.ok, true, assignLocB.message);
created.assignmentIds.push(assignLocB.assignment.id);

// Email linkage / session fields
const linkedA = await ensureManagementLinkedToUser({ userId: mgrA.id, email: mgrA.email });
const fieldsA = managementFieldsForPublicUser(linkedA);
assert.equal(fieldsA.isManager, true);
assert.equal(fieldsA.managementRole, "shop_manager");
assert.deepEqual(fieldsA.managementShopIds, [shopA.businessId]);
assert.equal(fieldsA.fullManagerAccess, true);
for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
  assert.equal(hasEffectivePermission(fieldsA.managerPermissions, cap), false);
}
assert.equal(isSuperAdminEmail(mgrA.email), false);
console.log("[mt-iso] PASS — future manager onboarding + session fields (Shop A)");

const ctxB = await loadActiveManagementContext(mgrB.id);
assert.ok(ctxB);
assert.deepEqual(ctxB.shopIds, [shopB.businessId]);
assert.equal(assertShopInManagementScope({ all: false, businessIds: ctxB.shopIds }, shopA.businessId), false);
assert.equal(assertShopInManagementScope({ all: false, businessIds: ctxB.shopIds }, shopB.businessId), true);
console.log("[mt-iso] PASS — Shop B manager denied Shop A scope");

const ctxA = await loadActiveManagementContext(mgrA.id);
assert.equal(assertShopInManagementScope({ all: false, businessIds: ctxA.shopIds }, shopB.businessId), false);
console.log("[mt-iso] PASS — Shop A manager denied Shop B scope");

const ctxLoc = await loadActiveManagementContext(locMgrB.id);
assert.equal(ctxLoc.role, "location_manager");
assert.ok(ctxLoc.locationIds.includes(shopB.locationId));
assert.equal(assertShopInManagementScope({ all: false, businessIds: ctxLoc.shopIds.length ? ctxLoc.shopIds : [shopB.businessId] }, shopA.businessId), false);
console.log("[mt-iso] PASS — location_manager scoped");

// platform_manager must still be explicitly assigned shops (never all shops)
const platformUser = await createCustomer("platformMgr");
const assignP = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  userId: platformUser.id,
  role: "platform_manager",
  shopIds: [shopA.businessId, shopB.businessId],
  locationIds: [],
  permissions: {},
  fullAccess: true,
});
assert.equal(assignP.ok, true, assignP.message);
created.assignmentIds.push(assignP.assignment.id);
const ctxP = await loadActiveManagementContext(platformUser.id);
assert.equal(ctxP.role, "platform_manager");
assert.ok(ctxP.shopIds.includes(shopA.businessId) && ctxP.shopIds.includes(shopB.businessId));
assert.equal(ctxP.shopIds.length, 2);
console.log("[mt-iso] PASS — platform_manager only assigned shops (not global)");

// Cannot assign Super Admin
const saBlock = await createManagementAssignment({
  actorUserId: actorId,
  actorEmail,
  email: "service@ifcdc.org",
  role: "shop_manager",
  shopIds: [shopA.businessId],
  locationIds: [],
  permissions: { manage_staff: true },
});
assert.equal(saBlock.ok, false);
console.log("[mt-iso] PASS — cannot assign Super Admin");

// Full manager access never includes Super Admin caps
const expanded = expandEffectivePermissions({ [MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS]: true });
for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
  assert.equal(expanded[cap], undefined);
}
console.log("[mt-iso] PASS — Full Manager Access ≠ Super Admin");

// Suspend/remove revokes immediately
const rem = await setManagementAssignmentStatus({
  assignmentId: assignB.assignment.id,
  status: "removed",
  actorUserId: actorId,
  actorEmail,
});
assert.equal(rem.ok, true);
assert.equal(await loadActiveManagementContext(mgrB.id), null);
console.log("[mt-iso] PASS — remove access clears manager context");

// Delete + same-email re-register must restore privileges (linked_email, not CASCADE wipe)
{
  const doomed = await createCustomer("rejoinMgr");
  const doomedEmail = String(doomed.email).toLowerCase();
  const assignRejoin = await createManagementAssignment({
    actorUserId: actorId,
    actorEmail,
    userId: doomed.id,
    role: "shop_manager",
    shopIds: [shopA.businessId],
    locationIds: [shopA.locationId],
    permissions: {},
    fullAccess: true,
  });
  assert.equal(assignRejoin.ok, true, assignRejoin.message);
  created.assignmentIds.push(assignRejoin.assignment.id);
  const beforeDelete = await loadActiveManagementContext(doomed.id);
  assert.equal(managementFieldsForPublicUser(beforeDelete).isManager, true);

  const deleted = await deleteAppUserAccount(doomed.id);
  assert.equal(deleted.ok, true, deleted.message || deleted.error);
  created.userIds = created.userIds.filter((id) => id !== String(doomed.id));
  assert.equal(await loadActiveManagementContext(doomed.id), null);

  const orphan = await dbQuery(
    `SELECT id, user_id, linked_email, status, role
     FROM management_assignments
     WHERE id = $1::uuid`,
    [assignRejoin.assignment.id],
  );
  assert.equal(orphan.rows?.[0]?.user_id, null);
  assert.equal(String(orphan.rows?.[0]?.linked_email || "").toLowerCase(), doomedEmail);
  assert.equal(orphan.rows?.[0]?.status, "active");
  assert.equal(orphan.rows?.[0]?.role, "shop_manager");

  const rejoined = await createCustomer("rejoinMgr");
  assert.equal(String(rejoined.email).toLowerCase(), doomedEmail);
  assert.notEqual(String(rejoined.id), String(doomed.id));

  const restored = await ensureManagementLinkedToUser({
    userId: rejoined.id,
    email: rejoined.email,
  });
  const restoredFields = managementFieldsForPublicUser(restored);
  assert.equal(restoredFields.isManager, true);
  assert.equal(restoredFields.managementRole, "shop_manager");
  assert.equal(restoredFields.managementStatus, "active");
  assert.deepEqual(restoredFields.managementShopIds, [shopA.businessId]);
  assert.ok(restoredFields.managementLocationIds.includes(shopA.locationId));
  assert.equal(restoredFields.fullManagerAccess, true);
  assert.equal(restored.userId, String(rejoined.id));
  console.log("[mt-iso] PASS — delete + same-email recreate restores shop_manager via linked_email");
}

// Manager list is Super Admin inventory (multiple managers coexist)
const team = await listManagementTeam({ includeRemoved: false });
assert.ok(team.some((m) => m.id === assignA.assignment.id));
assert.ok(!team.some((m) => m.id === assignB.assignment.id && m.status === "active"));
console.log("[mt-iso] PASS — multi-manager coexistence");

if (CLEANUP) {
  for (const id of created.assignmentIds) {
    await dbQuery(`DELETE FROM management_assignments WHERE id = $1::uuid`, [id]).catch(() => {});
  }
  for (const id of created.userIds) {
    await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid`, [id]).catch(() => {});
  }
  for (const id of created.locationIds) {
    await dbQuery(`DELETE FROM shop_locations WHERE id = $1::uuid`, [id]).catch(() => {});
  }
  for (const id of created.businessIds) {
    await dbQuery(`DELETE FROM businesses WHERE id = $1::bigint`, [id]).catch(() => {});
  }
  console.log("[mt-iso] cleaned fixtures");
}

console.log("[mt-iso] ALL PASS");
process.exit(0);
