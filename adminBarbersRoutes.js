import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  listAdminBarbers,
  listAdminNotifications,
  notifySuperAdminsNewBarber,
  parseLocationFields,
} from "./adminBarberService.js";

async function resolveBarberManagementScope(req, res) {
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
    return { all: true, actorId: String(payload.id || ""), isSuperAdmin: true };
  }

  const role = String(payload?.role || "").trim().toLowerCase();
  if (role === "admin") {
    return { all: true, actorId: String(payload.id || ""), isSuperAdmin: false };
  }

  if (role === "shop_owner") {
    const r = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(payload.id)]);
    const bid = r.rows?.[0]?.business_id;
    const businessId = bid != null && bid !== "" ? Number(bid) : NaN;
    if (!Number.isFinite(businessId)) {
      res.status(403).json({ ok: false, message: "Shop owner account is not linked to a business." });
      return null;
    }
    return { all: false, businessId, actorId: String(payload.id || ""), isSuperAdmin: false };
  }

  res.status(403).json({ ok: false, message: "Access denied" });
  return null;
}

export function createAdminBarbersRouter() {
  const router = express.Router();

  router.get("/api/admin/barbers", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;

    try {
      const barbers = await listAdminBarbers(scope, {
        shop: req.query.shop,
        city: req.query.city,
        state: req.query.state,
        active: req.query.active,
        activeInactive: req.query.activeInactive,
        pendingApproval: req.query.pendingApproval,
        sort: req.query.sort,
        registrationDate: req.query.registrationDate,
      });
      return res.json({ ok: true, barbers, total: barbers.length, scope: scope.all ? "global" : "shop" });
    } catch (e) {
      console.error("[admin/barbers] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load barbers" });
    }
  });

  router.patch("/api/admin/barbers/:id/verification", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can update verification." });
    }

    const barberId = Number(req.params.id);
    const status = String(req.body?.status || req.body?.verificationStatus || "").trim().toLowerCase();
    if (!Number.isFinite(barberId) || !["pending", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid barber id or verification status." });
    }

    try {
      const r = await dbQuery(
        `UPDATE barbers SET verification_status = $1 WHERE id = $2 RETURNING id`,
        [status, barberId],
      );
      if (!r.rows?.length) return res.status(404).json({ ok: false, message: "Barber not found" });
      return res.json({ ok: true, barberId, verificationStatus: status });
    } catch (e) {
      console.error("[admin/barbers] verification patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update verification" });
    }
  });

  router.patch("/api/admin/barbers/:id/account-status", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;

    const barberId = Number(req.params.id);
    const status = String(req.body?.status || req.body?.accountStatus || "").trim().toLowerCase();
    const mapped =
      status === "suspended" || status === "disabled"
        ? "disabled"
        : status === "pending"
          ? "pending"
          : status === "approved" || status === "active"
            ? "active"
            : "";
    if (!Number.isFinite(barberId) || !mapped) {
      return res.status(400).json({ ok: false, message: "Invalid barber id or account status." });
    }

    try {
      const barber = await dbQuery(`SELECT user_id, business_id FROM barbers WHERE id = $1 LIMIT 1`, [barberId]);
      const row = barber.rows?.[0];
      if (!row) return res.status(404).json({ ok: false, message: "Barber not found" });

      if (!scope.all) {
        const biz = row.business_id != null ? Number(row.business_id) : NaN;
        if (!Number.isFinite(biz) || biz !== scope.businessId) {
          return res.status(403).json({ ok: false, message: "You cannot manage this barber." });
        }
      }

      if (!row.user_id) {
        return res.status(400).json({ ok: false, message: "Barber is not linked to a user account." });
      }

      await dbQuery(`UPDATE app_users SET account_status = $1 WHERE id = $2::uuid`, [mapped, row.user_id]);
      if (mapped === "active" && scope.all) {
        await dbQuery(`UPDATE barbers SET verification_status = 'approved' WHERE id = $1`, [barberId]);
      }
      return res.json({ ok: true, barberId, accountStatus: mapped });
    } catch (e) {
      console.error("[admin/barbers] account-status patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update account status" });
    }
  });

  router.get("/api/admin/notifications", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Platform admin notifications only." });
    }

    try {
      const unreadOnly = String(req.query.unreadOnly || "").toLowerCase() === "true";
      const notifications = await listAdminNotifications(scope.actorId, { unreadOnly });
      return res.json({ ok: true, notifications });
    } catch (e) {
      console.error("[admin/notifications] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load notifications" });
    }
  });

  router.post("/api/admin/notifications/:id/read", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;

    try {
      await dbQuery(
        `UPDATE admin_user_notifications SET read_at = NOW()
         WHERE id = $1 AND user_id = $2::uuid`,
        [Number(req.params.id), scope.actorId],
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to mark notification read" });
    }
  });

  return router;
}

export { notifySuperAdminsNewBarber, parseLocationFields };
