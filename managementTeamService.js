/**
 * Management Team CRUD — Super Admin only for mutating assignments.
 */
import crypto from "node:crypto";
import { dbQuery } from "./db.js";
import { hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";
import { normalizeEmail } from "./authStore.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import {
  MANAGEMENT_PERMISSIONS,
  MANAGEMENT_ROLE_LABELS,
  MANAGEMENT_STATUSES,
  SCOPED_MANAGER_PERMISSION_KEYS,
  expandEffectivePermissions,
  isKnownPermissionKey,
  normalizePermissionKey,
  permissionCatalogForUi,
} from "./managementPermissions.js";
import { isProtectedSuperAdminUser } from "./managementTeamAuth.js";
import { logManagementActivity } from "./managementActivityLog.js";

function generateInvitePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const pick = (chars, n) =>
    Array.from(crypto.randomFillSync(new Uint8Array(n)), (b) => chars[b % chars.length]).join("");
  return `${pick(upper, 3)}${pick(lower, 5)}${pick(digits, 3)}${pick(symbols, 2)}`;
}

async function loadAssignmentRow(assignmentId) {
  const r = await dbQuery(`SELECT * FROM management_assignments WHERE id = $1::uuid LIMIT 1`, [
    String(assignmentId),
  ]);
  return r.rows?.[0] || null;
}

async function hydrateAssignment(row) {
  if (!row) return null;
  const [userRes, shopsRes, locsRes, permsRes] = await Promise.all([
    dbQuery(
      `SELECT id, name, email, phone, role, account_status FROM app_users WHERE id = $1::uuid LIMIT 1`,
      [row.user_id],
    ),
    dbQuery(
      `SELECT msa.business_id, b.name AS shop_name
       FROM manager_shop_access msa
       LEFT JOIN businesses b ON b.id = msa.business_id
       WHERE msa.assignment_id = $1::uuid
       ORDER BY b.name NULLS LAST`,
      [row.id],
    ),
    dbQuery(
      `SELECT mla.location_id, sl.name AS location_name, sl.business_id, sl.city, sl.state
       FROM manager_location_access mla
       LEFT JOIN shop_locations sl ON sl.id = mla.location_id
       WHERE mla.assignment_id = $1::uuid
       ORDER BY sl.name NULLS LAST`,
      [row.id],
    ),
    dbQuery(
      `SELECT permission_key, enabled FROM manager_permissions WHERE assignment_id = $1::uuid`,
      [row.id],
    ),
  ]);

  const permissionMap = {};
  for (const p of permsRes.rows || []) {
    permissionMap[String(p.permission_key)] = p.enabled === true;
  }
  if (row.full_access === true) {
    permissionMap[MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS] = true;
  }

  const user = userRes.rows?.[0] || null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    role: String(row.role),
    roleLabel: MANAGEMENT_ROLE_LABELS[row.role] || row.role,
    status: String(row.status),
    fullAccess: row.full_access === true,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at || null,
    removedAt: row.removed_at || null,
    user: user
      ? {
          id: String(user.id),
          name: user.name || null,
          email: user.email || null,
          phone: user.phone || null,
          role: user.role || null,
          accountStatus: user.account_status || null,
        }
      : null,
    shops: (shopsRes.rows || []).map((s) => ({
      businessId: Number(s.business_id),
      name: s.shop_name || `Shop #${s.business_id}`,
    })),
    locations: (locsRes.rows || []).map((l) => ({
      locationId: String(l.location_id),
      name: l.location_name || "Location",
      businessId: l.business_id != null ? Number(l.business_id) : null,
      city: l.city || null,
      state: l.state || null,
    })),
    permissions: expandEffectivePermissions(permissionMap),
  };
}

async function replaceShopAccess(assignmentId, shopIds) {
  await dbQuery(`DELETE FROM manager_shop_access WHERE assignment_id = $1::uuid`, [assignmentId]);
  for (const bid of shopIds) {
    await dbQuery(
      `INSERT INTO manager_shop_access (assignment_id, business_id) VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (assignment_id, business_id) DO NOTHING`,
      [assignmentId, Number(bid)],
    );
  }
}

async function replaceLocationAccess(assignmentId, locationIds) {
  await dbQuery(`DELETE FROM manager_location_access WHERE assignment_id = $1::uuid`, [assignmentId]);
  for (const lid of locationIds) {
    await dbQuery(
      `INSERT INTO manager_location_access (assignment_id, location_id) VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (assignment_id, location_id) DO NOTHING`,
      [assignmentId, String(lid)],
    );
  }
}

async function replacePermissions(assignmentId, permissions, fullAccess) {
  await dbQuery(`DELETE FROM manager_permissions WHERE assignment_id = $1::uuid`, [assignmentId]);
  const map = permissions && typeof permissions === "object" ? { ...permissions } : {};
  if (fullAccess) map[MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS] = true;

  const keys = new Set([
    MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS,
    ...SCOPED_MANAGER_PERMISSION_KEYS,
  ]);
  for (const key of keys) {
    const enabled =
      fullAccess && key !== MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS
        ? true
        : map[key] === true;
    if (!enabled && key !== MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS && !fullAccess) {
      if (map[key] !== true) continue;
    }
    const writeEnabled =
      key === MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS ? Boolean(fullAccess || map[key]) : enabled;
    if (!writeEnabled && key !== MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS) continue;
    await dbQuery(
      `INSERT INTO manager_permissions (assignment_id, permission_key, enabled)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (assignment_id, permission_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [assignmentId, key, writeEnabled],
    );
  }
  // Always persist full_manager_access flag row
  await dbQuery(
    `INSERT INTO manager_permissions (assignment_id, permission_key, enabled)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (assignment_id, permission_key)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [assignmentId, MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS, Boolean(fullAccess)],
  );
}

export async function listManagementTeam({ includeRemoved = false } = {}) {
  const statusFilter = includeRemoved
    ? `status IN ('active','suspended','removed')`
    : `status IN ('active','suspended')`;
  const r = await dbQuery(
    `SELECT * FROM management_assignments
     WHERE ${statusFilter}
     ORDER BY
       CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
       created_at DESC`,
  );
  const out = [];
  for (const row of r.rows || []) {
    out.push(await hydrateAssignment(row));
  }
  return out;
}

export async function getManagementAssignment(assignmentId) {
  const row = await loadAssignmentRow(assignmentId);
  if (!row) return null;
  return hydrateAssignment(row);
}

export async function findUserCandidates(query, { limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const r = await dbQuery(
    `SELECT id, name, email, phone, role, account_status
     FROM app_users
     WHERE (
       email ILIKE '%' || $1 || '%'
       OR coalesce(name,'') ILIKE '%' || $1 || '%'
       OR coalesce(phone,'') ILIKE '%' || $1 || '%'
     )
     ORDER BY email ASC
     LIMIT $2`,
    [q, lim],
  );
  return (r.rows || [])
    .filter((u) => !isProtectedSuperAdminUser(u))
    .map((u) => ({
      id: String(u.id),
      name: u.name || null,
      email: u.email,
      phone: u.phone || null,
      role: u.role,
      accountStatus: u.account_status,
    }));
}

export async function listShopsForAssignment() {
  const r = await dbQuery(
    `SELECT id, name, city, state, address, approval_status, account_status
     FROM businesses
     ORDER BY name ASC NULLS LAST
     LIMIT 500`,
  );
  return (r.rows || []).map((b) => ({
    businessId: Number(b.id),
    name: b.name || `Shop #${b.id}`,
    city: b.city || null,
    state: b.state || null,
    address: b.address || null,
    approvalStatus: b.approval_status || null,
    accountStatus: b.account_status || null,
  }));
}

export async function listLocationsForAssignment({ businessIds = null } = {}) {
  const params = [];
  let where = `status = 'active'`;
  if (Array.isArray(businessIds) && businessIds.length) {
    params.push(businessIds.map(Number).filter(Number.isFinite));
    where += ` AND business_id = ANY($${params.length}::bigint[])`;
  }
  const r = await dbQuery(
    `SELECT id, business_id, name, city, state, address, is_primary
     FROM shop_locations
     WHERE ${where}
     ORDER BY business_id, is_primary DESC, name ASC
     LIMIT 1000`,
    params,
  );
  return (r.rows || []).map((l) => ({
    locationId: String(l.id),
    businessId: Number(l.business_id),
    name: l.name || "Location",
    city: l.city || null,
    state: l.state || null,
    address: l.address || null,
    isPrimary: l.is_primary === true,
  }));
}

async function resolveOrCreateManagerUser({
  userId,
  email,
  name,
  phone,
  createIfMissing,
  password,
}) {
  if (userId) {
    const r = await dbQuery(
      `SELECT id, email, name, phone, role, account_status FROM app_users WHERE id = $1::uuid LIMIT 1`,
      [String(userId)],
    );
    const user = r.rows?.[0];
    if (!user) return { ok: false, status: 404, message: "User not found." };
    if (isProtectedSuperAdminUser(user)) {
      return { ok: false, status: 403, message: "Cannot assign management to Super Admin." };
    }
    return { ok: true, user, created: false, temporaryPassword: null };
  }

  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, status: 400, message: "Email is required." };
  if (isSuperAdminEmail(normalized)) {
    return { ok: false, status: 403, message: "Cannot assign management to Super Admin." };
  }

  const existing = await dbQuery(
    `SELECT id, email, name, phone, role, account_status FROM app_users WHERE lower(trim(email)) = $1 LIMIT 1`,
    [normalized],
  );
  if (existing.rows?.[0]) {
    return { ok: true, user: existing.rows[0], created: false, temporaryPassword: null };
  }

  if (!createIfMissing) {
    return { ok: false, status: 404, message: "User not found. Enable invite/create to add them." };
  }

  let plain = String(password || "").trim();
  if (!plain) plain = generateInvitePassword();
  const strength = validatePasswordStrength(plain);
  if (!strength.valid) {
    return { ok: false, status: 400, message: strength.message || "Weak password." };
  }
  const passwordHash = await hashPassword(plain);
  const inserted = await dbQuery(
    `INSERT INTO app_users (name, email, phone, password_hash, role, account_status)
     VALUES ($1, $2, $3, $4, 'user', 'active')
     RETURNING id, email, name, phone, role, account_status`,
    [String(name || "").trim() || normalized.split("@")[0], normalized, phone || null, passwordHash],
  );
  return { ok: true, user: inserted.rows[0], created: true, temporaryPassword: plain };
}

export async function createManagementAssignment({
  actorUserId,
  actorEmail,
  userId = null,
  email = null,
  name = null,
  phone = null,
  createIfMissing = false,
  password = null,
  role,
  shopIds = [],
  locationIds = [],
  permissions = {},
  fullAccess = false,
  notes = null,
  req = null,
}) {
  const resolved = await resolveOrCreateManagerUser({
    userId,
    email,
    name,
    phone,
    createIfMissing,
    password,
  });
  if (!resolved.ok) return resolved;

  const existingActive = await dbQuery(
    `SELECT id, status FROM management_assignments
     WHERE user_id = $1::uuid AND status IN ('active','suspended')
     LIMIT 1`,
    [resolved.user.id],
  );
  if (existingActive.rows?.[0]) {
    return {
      ok: false,
      status: 409,
      message: "This user already has a management assignment. Edit it instead.",
      assignmentId: String(existingActive.rows[0].id),
    };
  }

  // Ensure locations belong to assigned shops when both provided
  if (locationIds.length && shopIds.length) {
    const check = await dbQuery(
      `SELECT id FROM shop_locations
       WHERE id = ANY($1::uuid[])
         AND business_id = ANY($2::bigint[])`,
      [locationIds, shopIds],
    );
    if ((check.rows || []).length !== locationIds.length) {
      return {
        ok: false,
        status: 400,
        message: "One or more locations are outside the selected shops.",
      };
    }
  }

  const inserted = await dbQuery(
    `INSERT INTO management_assignments (user_id, role, status, full_access, notes, created_by)
     VALUES ($1::uuid, $2, 'active', $3, $4, $5::uuid)
     RETURNING *`,
    [resolved.user.id, role, Boolean(fullAccess), notes || null, actorUserId || null],
  );
  const assignment = inserted.rows[0];
  await replaceShopAccess(assignment.id, shopIds);
  await replaceLocationAccess(assignment.id, locationIds);
  await replacePermissions(assignment.id, permissions, Boolean(fullAccess));

  const hydrated = await hydrateAssignment(assignment);
  await logManagementActivity({
    actorUserId,
    actorEmail,
    actorAssignmentId: null,
    action: "manager_assigned",
    recordType: "management_assignment",
    recordId: assignment.id,
    afterValue: {
      role,
      shopIds,
      locationIds,
      fullAccess: Boolean(fullAccess),
      userId: resolved.user.id,
    },
    metadata: { createdUser: resolved.created },
    req,
  });

  return {
    ok: true,
    assignment: hydrated,
    createdUser: resolved.created,
    temporaryPassword: resolved.temporaryPassword,
  };
}

export async function updateManagementAssignment({
  assignmentId,
  actorUserId,
  actorEmail,
  role,
  shopIds,
  locationIds,
  permissions,
  fullAccess,
  notes,
  req = null,
}) {
  const before = await getManagementAssignment(assignmentId);
  if (!before) return { ok: false, status: 404, message: "Assignment not found." };
  if (before.status === MANAGEMENT_STATUSES.REMOVED) {
    return { ok: false, status: 400, message: "Cannot edit a removed assignment. Create a new one." };
  }

  const nextRole = role || before.role;
  const nextShops = Array.isArray(shopIds) ? shopIds : before.shops.map((s) => s.businessId);
  const nextLocs = Array.isArray(locationIds)
    ? locationIds
    : before.locations.map((l) => l.locationId);
  const nextFull =
    typeof fullAccess === "boolean" ? fullAccess : before.fullAccess;
  const nextPerms = permissions && typeof permissions === "object" ? permissions : before.permissions;

  await dbQuery(
    `UPDATE management_assignments
     SET role = $2,
         full_access = $3,
         notes = COALESCE($4, notes),
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [assignmentId, nextRole, nextFull, notes === undefined ? null : notes],
  );
  await replaceShopAccess(assignmentId, nextShops);
  await replaceLocationAccess(assignmentId, nextLocs);
  await replacePermissions(assignmentId, nextPerms, nextFull);

  const after = await getManagementAssignment(assignmentId);
  await logManagementActivity({
    actorUserId,
    actorEmail,
    action: "manager_updated",
    recordType: "management_assignment",
    recordId: assignmentId,
    beforeValue: before,
    afterValue: after,
    req,
  });
  return { ok: true, assignment: after };
}

export async function setManagementAssignmentStatus({
  assignmentId,
  status,
  actorUserId,
  actorEmail,
  req = null,
}) {
  const before = await getManagementAssignment(assignmentId);
  if (!before) return { ok: false, status: 404, message: "Assignment not found." };

  const next = String(status || "").trim().toLowerCase();
  if (!["active", "suspended", "removed"].includes(next)) {
    return { ok: false, status: 400, message: "Invalid status." };
  }

  if (next === "suspended") {
    await dbQuery(
      `UPDATE management_assignments
       SET status = 'suspended', suspended_at = NOW(), suspended_by = $2::uuid, updated_at = NOW()
       WHERE id = $1::uuid`,
      [assignmentId, actorUserId || null],
    );
  } else if (next === "removed") {
    await dbQuery(
      `UPDATE management_assignments
       SET status = 'removed', removed_at = NOW(), removed_by = $2::uuid, updated_at = NOW()
       WHERE id = $1::uuid`,
      [assignmentId, actorUserId || null],
    );
  } else {
    await dbQuery(
      `UPDATE management_assignments
       SET status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = NOW()
       WHERE id = $1::uuid`,
      [assignmentId],
    );
  }

  const after = await getManagementAssignment(assignmentId);
  await logManagementActivity({
    actorUserId,
    actorEmail,
    action:
      next === "suspended"
        ? "manager_suspended"
        : next === "removed"
          ? "manager_access_removed"
          : "manager_reactivated",
    recordType: "management_assignment",
    recordId: assignmentId,
    beforeValue: { status: before.status },
    afterValue: { status: after?.status },
    req,
  });
  return { ok: true, assignment: after };
}

export function managementTeamMeta() {
  return {
    roles: Object.entries(MANAGEMENT_ROLE_LABELS).map(([value, label]) => ({ value, label })),
    permissions: permissionCatalogForUi(),
    statuses: Object.values(MANAGEMENT_STATUSES),
  };
}

export function sanitizePermissionPatch(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [rawKey, rawVal] of Object.entries(input)) {
    const key = normalizePermissionKey(rawKey);
    if (!isKnownPermissionKey(key)) continue;
    out[key] = rawVal === true;
  }
  return out;
}
