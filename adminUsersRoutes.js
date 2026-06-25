import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import { ALLOWED_ROLES } from "./authDbMigrations.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import { registerAdminInviteRoutes, registerPublicInviteRoutes } from "./adminInviteRoutes.js";
import { registerAdminAuditRoutes } from "./adminAuditRoutes.js";
import { registerAdminPasswordResetRoutes } from "./adminPasswordResetRoutes.js";
import { logAdminActivity, ADMIN_ACTIVITY } from "./adminActivityLog.js";

function rowToUser(row) {
  return {
    id: String(row.id),
    name: row.name || "—",
    email: row.email,
    phone: row.phone || null,
    role: row.role || "user",
    status: String(row.account_status || "active").toLowerCase() === "disabled" ? "disabled" : "active",
    profileImageUrl: row.profile_image_url || null,
    businessId: row.business_id ?? null,
    businessName: row.business_name ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastLogin: null,
  };
}

async function resolveUserManagementScope(req, res) {
  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ ok: false, message: "Missing Bearer token" });
    return null;
  }
  const payload = resolveAuthPayload(token);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Invalid or expired token" });
    return null;
  }
  req.user = payload;

  if (isJwtGlobalSuperScope(payload)) {
    return { all: true, actorId: String(payload.id || "") };
  }

  const role = String(payload?.role || "").trim().toLowerCase();
  if (role === "shop_owner") {
    const r = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(payload.id)]);
    const bid = r.rows?.[0]?.business_id;
    const businessId = bid != null && bid !== "" ? Number(bid) : NaN;
    if (!Number.isFinite(businessId)) {
      res.status(403).json({ ok: false, message: "Shop owner account is not linked to a business." });
      return null;
    }
    return { all: false, businessId, actorId: String(payload.id || "") };
  }

  res.status(403).json({ ok: false, message: "Access denied" });
  return null;
}

async function loadManagedUser(userId) {
  const r = await dbQuery(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.account_status, u.profile_image_url,
            u.business_id, u.created_at, b.name AS business_name
     FROM app_users u
     LEFT JOIN businesses b ON b.id = u.business_id
     WHERE u.id = $1::uuid
     LIMIT 1`,
    [String(userId)],
  );
  return r.rows?.[0] || null;
}

function canManageTarget(scope, row) {
  if (!row) return false;
  if (scope.all) return true;
  const targetBiz = row.business_id != null ? Number(row.business_id) : NaN;
  if (!Number.isFinite(targetBiz) || targetBiz !== scope.businessId) return false;
  const role = String(row.role || "").toLowerCase();
  if (role === "super_admin" || role === "admin") return false;
  return true;
}

const SHOP_OWNER_ASSIGNABLE_ROLES = new Set(["barber", "user", "shop_owner"]);

function isMasterUserRow(row) {
  return isSuperAdminEmail(row?.email);
}

async function applyUserPatch(scope, userId, patch, res) {
  const existing = await loadManagedUser(userId);
  if (!existing) return res.status(404).json({ ok: false, message: "User not found" });
  if (!canManageTarget(scope, existing)) {
    return res.status(403).json({ ok: false, message: "You cannot edit this account." });
  }

  const sets = [];
  const params = [];
  let i = 1;

  if (patch.role != null) {
    let role = String(patch.role).trim().toLowerCase();
    if (role === "customer") role = "user";
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, message: "Invalid role" });
    }
    if (isMasterUserRow(existing) && role !== "super_admin") {
      return res.status(403).json({ ok: false, message: "Master IFCDC account must remain super_admin." });
    }
    if (role === "super_admin" && !isMasterUserRow(existing)) {
      return res.status(403).json({ ok: false, message: "Super admin role is restricted to the master account." });
    }
    if (scope.actorId === userId && String(existing.role).toLowerCase() === "super_admin" && role !== "super_admin") {
      return res.status(403).json({ ok: false, message: "You cannot remove your own super admin access." });
    }
    if (!scope.all && !SHOP_OWNER_ASSIGNABLE_ROLES.has(role)) {
      return res.status(403).json({ ok: false, message: "You cannot assign that role." });
    }
    sets.push(`role = $${i++}`);
    params.push(role);
  }

  if (patch.status != null) {
    if (isMasterUserRow(existing)) {
      return res.status(403).json({ ok: false, message: "Master IFCDC account cannot be suspended." });
    }
    if (scope.actorId === userId && String(patch.status).toLowerCase() === "disabled") {
      return res.status(403).json({ ok: false, message: "You cannot suspend your own account." });
    }
    const status = String(patch.status).toLowerCase() === "disabled" ? "disabled" : "active";
    sets.push(`account_status = $${i++}`);
    params.push(status);
  }

  if (!sets.length) {
    return res.status(400).json({ ok: false, message: "No fields to update" });
  }

  params.push(userId);
  const updated = await dbQuery(
    `UPDATE app_users SET ${sets.join(", ")} WHERE id = $${i}::uuid
     RETURNING id, name, email, phone, role, account_status, profile_image_url, business_id, created_at`,
    params,
  );
  const row = updated.rows?.[0];
  if (!row) return res.status(404).json({ ok: false, message: "User not found" });

  const bizJoin = await dbQuery(`SELECT b.name AS business_name FROM businesses b WHERE b.id = $1 LIMIT 1`, [
    row.business_id,
  ]);
  row.business_name = bizJoin.rows?.[0]?.business_name ?? null;

  if (patch.role != null && String(existing.role).toLowerCase() !== String(row.role).toLowerCase()) {
    void logAdminActivity({
      eventType: ADMIN_ACTIVITY.ROLE_CHANGED,
      adminUserId: scope.actorId,
      userEmail: row.email,
      userName: row.name,
      detail: `Role changed from ${existing.role} to ${row.role}`,
      metadata: { userId, previousRole: existing.role, newRole: row.role },
      req: scope.req,
    });
  }
  if (patch.status != null && String(existing.account_status).toLowerCase() !== String(row.account_status).toLowerCase()) {
    if (String(row.account_status).toLowerCase() === "disabled") {
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.ACCOUNT_SUSPENDED,
        adminUserId: scope.actorId,
        userEmail: row.email,
        userName: row.name,
        detail: `Account suspended: ${row.email}`,
        metadata: { userId, previousStatus: existing.account_status },
        req: scope.req,
      });
    }
  }

  return res.json({ ok: true, user: rowToUser(row) });
}

export function createAdminUsersRouter(options = {}) {
  const router = express.Router();

  router.get("/api/admin/users", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const params = [];
      let where = "";
      if (!scope.all) {
        where = " WHERE u.business_id = $1 ";
        params.push(scope.businessId);
      }
      const r = await dbQuery(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.account_status, u.profile_image_url,
                u.business_id, u.created_at, b.name AS business_name
         FROM app_users u
         LEFT JOIN businesses b ON b.id = u.business_id
         ${where}
         ORDER BY u.created_at DESC NULLS LAST
         LIMIT 500`,
        params,
      );
      const users = (r.rows || []).map(rowToUser);
      return res.json({ ok: true, users });
    } catch (e) {
      console.error("[admin/users] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load users" });
    }
  });

  router.get("/api/admin/users/:id", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const row = await loadManagedUser(req.params.id);
      if (!row) return res.status(404).json({ ok: false, message: "User not found" });
      if (!canManageTarget(scope, row)) {
        return res.status(403).json({ ok: false, message: "You cannot view this account." });
      }
      return res.json({ ok: true, user: rowToUser(row) });
    } catch (e) {
      console.error("[admin/users] detail failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load user" });
    }
  });

  router.put("/api/admin/user-role", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;
    const userId = String(req.body?.userId || req.body?.id || "").trim();
    const role = req.body?.role;
    if (!userId || role == null) {
      return res.status(400).json({ ok: false, message: "userId and role are required." });
    }
    try {
      scope.req = req;
      return await applyUserPatch(scope, userId, { role }, res);
    } catch (e) {
      console.error("[admin/users] user-role failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update role" });
    }
  });

  router.put("/api/admin/user-status", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;
    const userId = String(req.body?.userId || req.body?.id || "").trim();
    const status = req.body?.status;
    if (!userId || status == null) {
      return res.status(400).json({ ok: false, message: "userId and status are required." });
    }
    try {
      scope.req = req;
      return await applyUserPatch(scope, userId, { status }, res);
    } catch (e) {
      console.error("[admin/users] user-status failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update status" });
    }
  });

  router.put("/api/admin/users/:id", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const userId = String(req.params.id || "").trim();
      const existing = await loadManagedUser(userId);
      if (!existing) return res.status(404).json({ ok: false, message: "User not found" });
      if (!canManageTarget(scope, existing)) {
        return res.status(403).json({ ok: false, message: "You cannot edit this account." });
      }

      const body = req.body || {};
      const sets = [];
      const params = [];
      let i = 1;

      if (body.name != null) {
        const name = String(body.name).trim().slice(0, 255);
        if (!name) return res.status(400).json({ ok: false, message: "Name cannot be empty" });
        sets.push(`name = $${i++}`);
        params.push(name);
      }

      if (body.phone !== undefined) {
        const phone = body.phone != null ? String(body.phone).replace(/\D/g, "").slice(0, 15) : null;
        sets.push(`phone = $${i++}`);
        params.push(phone || null);
      }

      if (body.profileImageUrl !== undefined) {
        const url = body.profileImageUrl != null ? String(body.profileImageUrl).trim().slice(0, 2048) : null;
        sets.push(`profile_image_url = $${i++}`);
        params.push(url || null);
      }

      if (body.role != null) {
        let role = String(body.role).trim().toLowerCase();
        if (role === "customer") role = "user";
        if (!ALLOWED_ROLES.includes(role)) {
          return res.status(400).json({ ok: false, message: "Invalid role" });
        }
        if (!scope.all) {
          if (!SHOP_OWNER_ASSIGNABLE_ROLES.has(role)) {
            return res.status(403).json({ ok: false, message: "You cannot assign that role." });
          }
        }
        sets.push(`role = $${i++}`);
        params.push(role);
      }

      if (body.status != null) {
        const status = String(body.status).toLowerCase() === "disabled" ? "disabled" : "active";
        sets.push(`account_status = $${i++}`);
        params.push(status);
      }

      if (body.businessId !== undefined) {
        if (!scope.all) {
          const nextBiz = body.businessId != null && body.businessId !== "" ? Number(body.businessId) : NaN;
          if (!Number.isFinite(nextBiz) || nextBiz !== scope.businessId) {
            return res.status(403).json({ ok: false, message: "You can only assign users to your shop." });
          }
        }
        const bizRaw = body.businessId;
        if (bizRaw == null || bizRaw === "") {
          sets.push(`business_id = $${i++}`);
          params.push(null);
        } else {
          const bizId = Number(bizRaw);
          if (!Number.isFinite(bizId)) {
            return res.status(400).json({ ok: false, message: "Invalid business id" });
          }
          const biz = await dbQuery(`SELECT id FROM businesses WHERE id = $1 LIMIT 1`, [bizId]);
          if (!biz.rows?.length) {
            return res.status(400).json({ ok: false, message: "Business not found" });
          }
          sets.push(`business_id = $${i++}`);
          params.push(bizId);
        }
      }

      if (!sets.length) {
        return res.status(400).json({ ok: false, message: "No fields to update" });
      }

      params.push(userId);
      const updated = await dbQuery(
        `UPDATE app_users SET ${sets.join(", ")} WHERE id = $${i}::uuid
         RETURNING id, name, email, phone, role, account_status, profile_image_url, business_id, created_at`,
        params,
      );
      const row = updated.rows?.[0];
      if (!row) return res.status(404).json({ ok: false, message: "User not found" });

      const bizJoin = await dbQuery(
        `SELECT b.name AS business_name FROM businesses b WHERE b.id = $1 LIMIT 1`,
        [row.business_id],
      );
      row.business_name = bizJoin.rows?.[0]?.business_name ?? null;

      return res.json({ ok: true, user: rowToUser(row) });
    } catch (e) {
      console.error("[admin/users] update failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update user" });
    }
  });

  registerAdminInviteRoutes(router, { sendEmail: options.sendEmail });
  registerPublicInviteRoutes(router);
  registerAdminAuditRoutes(router);
  registerAdminPasswordResetRoutes(router, { sendEmail: options.sendEmail });

  return router;
}
