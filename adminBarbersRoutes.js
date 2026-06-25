import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  assertBarberInScope,
  assignBarberToShop,
  deleteAdminBarber,
  getAdminBarberById,
  listAdminBarbers,
  listAdminNotifications,
  notifySuperAdminsNewBarber,
  parseLocationFields,
  setBarberBookingHidden,
  updateAdminBarberProfile,
  updateBarberAccountStatus,
  updateBarberSubscriptionTier,
  updateBarberVerification,
} from "./adminBarberService.js";
import {
  backfillOrphanBarberRegistrations,
  getBarberSignupAudit,
} from "./signupProvisioningService.js";
import { logAdminActivity, ADMIN_ACTIVITY } from "./adminActivityLog.js";

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

async function loadScopedBarber(scope, barberId, res) {
  const barber = await getAdminBarberById(scope, barberId);
  if (!barber) {
    res.status(404).json({ ok: false, message: "Barber not found" });
    return null;
  }
  return barber;
}

export function createAdminBarbersRouter() {
  const router = express.Router();

  router.get("/api/admin/barbers", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;

    try {
      let backfill = null;
      if (scope.all) {
        try {
          backfill = await backfillOrphanBarberRegistrations({ notify: false });
          if (backfill?.fixed > 0) {
            console.log("[admin/barbers] backfilled orphan registrations:", backfill);
          }
        } catch (bfErr) {
          console.warn("[admin/barbers] orphan backfill skipped:", bfErr?.message || bfErr);
        }
      }

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
      return res.json({
        ok: true,
        barbers,
        total: barbers.length,
        scope: scope.all ? "global" : "shop",
        backfill,
      });
    } catch (e) {
      console.error("[admin/barbers] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load barbers" });
    }
  });

  router.get("/api/admin/barbers/signup-audit", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Platform admin only." });
    }
    try {
      const audit = await getBarberSignupAudit();
      return res.json({ ok: true, audit });
    } catch (e) {
      console.error("[admin/barbers] signup-audit failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Audit failed" });
    }
  });

  router.get("/api/admin/barbers/:id", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    try {
      const barber = await loadScopedBarber(scope, req.params.id, res);
      if (!barber) return;
      return res.json({ ok: true, barber });
    } catch (e) {
      console.error("[admin/barbers] detail failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load barber" });
    }
  });

  router.patch("/api/admin/barbers/:id", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can edit barber profiles." });
    }

    try {
      const row = await dbQuery(`SELECT business_id FROM barbers WHERE id::text = $1::text LIMIT 1`, [
        String(req.params.id),
      ]);
      const access = assertBarberInScope(scope, row.rows?.[0]);
      if (!access.ok) return res.status(access.message === "Barber not found" ? 404 : 403).json(access);

      const result = await updateAdminBarberProfile(req.params.id, {
        name: req.body?.name ?? req.body?.fullName,
        shopName: req.body?.shopName,
        phone: req.body?.phone,
        location: req.body?.location ?? req.body?.locationLabel,
        email: req.body?.email,
      });
      if (!result.ok) return res.status(400).json(result);
      const barber = await getAdminBarberById(scope, req.params.id);
      return res.json({ ok: true, barber });
    } catch (e) {
      console.error("[admin/barbers] patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update barber" });
    }
  });

  router.patch("/api/admin/barbers/:id/verification", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can update verification." });
    }

    const status = String(req.body?.status || req.body?.verificationStatus || "").trim().toLowerCase();
    try {
      const result = await updateBarberVerification(req.params.id, status);
      if (!result.ok) return res.status(400).json(result);
      const barber = await getAdminBarberById(scope, req.params.id);
      const targetEmail = String(barber?.email || barber?.userEmail || "").trim();
      if (status === "approved") {
        void logAdminActivity({
          eventType: ADMIN_ACTIVITY.BARBER_APPROVED,
          adminUserId: scope.actorId,
          userEmail: targetEmail || null,
          userName: barber?.name || null,
          detail: `Barber approved: ${barber?.name || req.params.id}`,
          metadata: { barberId: req.params.id, verificationStatus: status },
          req,
        });
      } else if (status === "rejected") {
        void logAdminActivity({
          eventType: ADMIN_ACTIVITY.ACCOUNT_DENIED,
          adminUserId: scope.actorId,
          userEmail: targetEmail || null,
          userName: barber?.name || null,
          detail: `Barber application denied: ${barber?.name || req.params.id}`,
          metadata: { barberId: req.params.id, verificationStatus: status },
          req,
        });
      }
      return res.json({ ok: true, ...result, barber });
    } catch (e) {
      console.error("[admin/barbers] verification patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update verification" });
    }
  });

  router.patch("/api/admin/barbers/:id/account-status", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;

    const status = String(req.body?.status || req.body?.accountStatus || "").trim().toLowerCase();
    try {
      const row = await dbQuery(`SELECT id, user_id, business_id FROM barbers WHERE id::text = $1::text LIMIT 1`, [
        String(req.params.id),
      ]);
      const access = assertBarberInScope(scope, row.rows?.[0]);
      if (!access.ok) return res.status(access.message === "Barber not found" ? 404 : 403).json(access);

      const result = await updateBarberAccountStatus(req.params.id, status, {
        autoApproveVerification: scope.all,
      });
      if (!result.ok) return res.status(400).json(result);
      const barber = await getAdminBarberById(scope, req.params.id);
      const targetEmail = String(barber?.email || barber?.userEmail || "").trim();
      if (status === "disabled" || status === "suspended") {
        void logAdminActivity({
          eventType: ADMIN_ACTIVITY.ACCOUNT_SUSPENDED,
          adminUserId: scope.actorId,
          userEmail: targetEmail || null,
          userName: barber?.name || null,
          detail: `Barber account suspended: ${barber?.name || req.params.id}`,
          metadata: { barberId: req.params.id, accountStatus: status },
          req,
        });
      }
      return res.json({ ok: true, ...result, barber });
    } catch (e) {
      console.error("[admin/barbers] account-status patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update account status" });
    }
  });

  router.patch("/api/admin/barbers/:id/assign-shop", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can assign shops." });
    }

    try {
      const result = await assignBarberToShop(
        req.params.id,
        req.body?.businessId ?? req.body?.shopId,
        req.body?.shopName,
      );
      if (!result.ok) return res.status(400).json(result);
      const barber = await getAdminBarberById(scope, req.params.id);
      return res.json({ ok: true, ...result, barber });
    } catch (e) {
      console.error("[admin/barbers] assign-shop failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to assign shop" });
    }
  });

  router.patch("/api/admin/barbers/:id/subscription", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can change subscription tier." });
    }

    const tier = String(req.body?.tier || req.body?.subscriptionTier || "").trim().toLowerCase();
    try {
      const result = await updateBarberSubscriptionTier(req.params.id, tier);
      if (!result.ok) return res.status(400).json(result);
      const barber = await getAdminBarberById(scope, req.params.id);
      return res.json({ ok: true, ...result, barber });
    } catch (e) {
      console.error("[admin/barbers] subscription patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update subscription" });
    }
  });

  router.patch("/api/admin/barbers/:id/booking-visibility", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can hide barbers from booking." });
    }

    const hidden =
      req.body?.hidden ??
      req.body?.bookingHidden ??
      req.body?.archive ??
      req.body?.archived;
    if (hidden == null) {
      return res.status(400).json({ ok: false, message: "Pass hidden: true or false." });
    }

    try {
      const row = await dbQuery(`SELECT business_id FROM barbers WHERE id::text = $1::text LIMIT 1`, [
        String(req.params.id),
      ]);
      const access = assertBarberInScope(scope, row.rows?.[0]);
      if (!access.ok) return res.status(access.message === "Barber not found" ? 404 : 403).json(access);

      const barberDetail = await getAdminBarberById(scope, req.params.id);
      const targetEmail = String(barberDetail?.email || barberDetail?.userEmail || "").trim();
      const result = await setBarberBookingHidden(req.params.id, Boolean(hidden));
      if (!result.ok) return res.status(400).json(result);

      void logAdminActivity({
        eventType: result.bookingHidden
          ? ADMIN_ACTIVITY.BARBER_BOOKING_HIDDEN
          : ADMIN_ACTIVITY.BARBER_BOOKING_VISIBLE,
        adminUserId: scope.actorId,
        userEmail: targetEmail || null,
        userName: barberDetail?.fullName || barberDetail?.name || null,
        detail: result.bookingHidden
          ? `Barber hidden from bookings: ${barberDetail?.fullName || req.params.id}`
          : `Barber restored to bookings: ${barberDetail?.fullName || req.params.id}`,
        metadata: { barberId: req.params.id, bookingHidden: result.bookingHidden },
        req,
      });

      const barber = await getAdminBarberById(scope, req.params.id);
      return res.json({ ok: true, ...result, barber });
    } catch (e) {
      console.error("[admin/barbers] booking-visibility patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update booking visibility" });
    }
  });

  router.delete("/api/admin/barbers/:id", async (req, res) => {
    const scope = await resolveBarberManagementScope(req, res);
    if (!scope) return;
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can delete barbers." });
    }

    try {
      const row = await dbQuery(`SELECT business_id FROM barbers WHERE id::text = $1::text LIMIT 1`, [
        String(req.params.id),
      ]);
      const access = assertBarberInScope(scope, row.rows?.[0]);
      if (!access.ok) return res.status(access.message === "Barber not found" ? 404 : 403).json(access);

      const barberDetail = await getAdminBarberById(scope, req.params.id);
      const targetEmail = String(barberDetail?.email || barberDetail?.userEmail || "").trim();

      const result = await deleteAdminBarber(req.params.id);
      if (result.ok) {
        void logAdminActivity({
          eventType: ADMIN_ACTIVITY.ACCOUNT_DELETED,
          adminUserId: scope.actorId,
          userEmail: targetEmail || null,
          userName: barberDetail?.name || null,
          detail: `Barber deleted: ${barberDetail?.name || req.params.id}`,
          metadata: { barberId: req.params.id, softDeleted: result.softDeleted ?? false },
          req,
        });
      }
      return res.json(result);
    } catch (e) {
      console.error("[admin/barbers] delete failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to delete barber" });
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
