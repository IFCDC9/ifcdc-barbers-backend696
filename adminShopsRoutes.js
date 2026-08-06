import express from "express";
import { createRequire } from "node:module";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  approveShop,
  deleteAdminShop,
  endShopTrial,
  getAdminShopDashboard,
  getAdminShopDetail,
  listAdminShops,
  rejectShop,
  setShopAccountStatus,
  startShopTrial,
  updateAdminShop,
  updateShopAccessControls,
} from "./adminShopsService.js";
import { logAdminActivity, ADMIN_ACTIVITY } from "./adminActivityLog.js";

const require = createRequire(import.meta.url);

async function loadShopOwnerEmail(businessId) {
  const r = await dbQuery(
    `SELECT email, name FROM app_users
     WHERE business_id = $1::bigint AND lower(coalesce(role, '')) = 'shop_owner'
     LIMIT 1`,
    [Number(businessId)],
  );
  return r.rows?.[0] || null;
}

async function resolveShopManagementScope(req, res) {
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

function assertShopInScope(scope, businessId) {
  if (scope.all) return true;
  return Number(scope.businessId) === Number(businessId);
}

function requirePlatformAdmin(scope, res) {
  if (!scope.all) {
    res.status(403).json({ ok: false, message: "Platform admin access required." });
    return false;
  }
  return true;
}

export function createAdminShopsRouter() {
  const router = express.Router();

  router.get("/api/admin/shops/dashboard", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    try {
      const dashboard = await getAdminShopDashboard();
      const pending = await listAdminShops(scope, { pendingApproval: "true" });
      return res.json({ ok: true, dashboard, pendingQueue: pending });
    } catch (e) {
      console.error("[admin/shops] dashboard failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load shop dashboard" });
    }
  });

  router.get("/api/admin/shops", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    try {
      const shops = await listAdminShops(scope, {
        shop: req.query.shop,
        name: req.query.name,
        city: req.query.city,
        state: req.query.state,
        status: req.query.status,
        accountStatus: req.query.accountStatus,
        pendingApproval: req.query.pendingApproval,
        sort: req.query.sort,
      });
      return res.json({ ok: true, shops, total: shops.length, scope: scope.all ? "global" : "shop" });
    } catch (e) {
      console.error("[admin/shops] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load shops" });
    }
  });

  router.get("/api/admin/shops/:id", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    if (!assertShopInScope(scope, businessId)) {
      return res.status(403).json({ ok: false, message: "That shop is outside your scope." });
    }
    try {
      const detail = await getAdminShopDetail(businessId);
      if (!detail) return res.status(404).json({ ok: false, message: "Shop not found" });
      const { getShopTelephonySettings, buildGreetingPreview } = require("./auraShopTelephonyAdmin.cjs");
      const telephony = await getShopTelephonySettings(dbQuery, businessId).catch(() => null);
      return res.json({
        ok: true,
        ...detail,
        telephony,
        greetingPreview: buildGreetingPreview(telephony),
      });
    } catch (e) {
      console.error("[admin/shops] detail failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load shop detail" });
    }
  });

  router.get("/api/admin/shops/:id/telephony", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    if (!assertShopInScope(scope, businessId)) {
      return res.status(403).json({ ok: false, message: "That shop is outside your scope." });
    }
    try {
      const { getShopTelephonySettings, buildGreetingPreview } = require("./auraShopTelephonyAdmin.cjs");
      const telephony = await getShopTelephonySettings(dbQuery, businessId);
      if (!telephony) return res.status(404).json({ ok: false, message: "Shop not found" });
      return res.json({
        ok: true,
        telephony,
        greetingPreview: buildGreetingPreview(telephony),
        tests: {
          testGreeting: buildGreetingPreview(telephony),
          callTelHref: telephony.callTelHref,
          note: "Test incoming/outgoing calls require Twilio console + Founder authorization to provision numbers.",
        },
      });
    } catch (e) {
      console.error("[admin/shops] telephony get failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load telephony settings" });
    }
  });

  router.put("/api/admin/shops/:id/telephony", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    if (!assertShopInScope(scope, businessId)) {
      return res.status(403).json({ ok: false, message: "That shop is outside your scope." });
    }
    // Twilio number / SID assignment is founder/platform-admin only
    const body = req.body || {};
    const highImpact =
      body.twilioPhoneNumber != null ||
      body.twilioPhoneE164 != null ||
      body.twilioPhoneNumberSid != null ||
      body.twilioPhoneSid != null;
    if (highImpact && !scope.all) {
      return res.status(403).json({
        ok: false,
        message: "Assigning or changing Twilio numbers requires platform Founder/admin authorization.",
      });
    }
    try {
      const { updateShopTelephonySettings, buildGreetingPreview } = require("./auraShopTelephonyAdmin.cjs");
      const { auditShopInfoUpdate } = require("./auraShopContext.cjs");
      const before = await require("./auraShopTelephonyAdmin.cjs").getShopTelephonySettings(dbQuery, businessId);
      const out = await updateShopTelephonySettings(dbQuery, businessId, body, {
        actor: { role: scope.isSuperAdmin ? "super_admin" : scope.all ? "admin" : "shop_owner", id: scope.actorId },
      });
      if (!out.ok) return res.status(400).json(out);
      for (const key of Object.keys(body)) {
        await auditShopInfoUpdate(dbQuery, {
          shopId: businessId,
          actorRole: scope.isSuperAdmin ? "super_admin" : scope.all ? "admin" : "shop_owner",
          fieldName: key,
          oldValue: before?.[key] ?? null,
          newValue: body[key],
          verified: true,
          success: true,
          detail: { via: "admin_api" },
        });
      }
      void logAdminActivity({
        eventType: "shop_telephony_updated",
        adminUserId: scope.actorId,
        metadata: { businessId, fields: Object.keys(body) },
      }).catch(() => {});
      return res.json({
        ok: true,
        telephony: out.settings,
        greetingPreview: buildGreetingPreview(out.settings),
      });
    } catch (e) {
      console.error("[admin/shops] telephony put failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update telephony settings" });
    }
  });

  router.post("/api/admin/shops/:id/approve", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    const plan = String(req.body?.plan || "free").toLowerCase();
    try {
      const ownerBefore = await loadShopOwnerEmail(businessId);
      const result = await approveShop(
        businessId,
        { plan, trialDays: req.body?.trialDays, monthlyPrice: req.body?.monthlyPrice },
        scope.actorId,
      );
      if (!result.ok) return res.status(400).json(result);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.SHOP_OWNER_APPROVED,
        adminUserId: scope.actorId,
        userEmail: ownerBefore?.email || null,
        userName: ownerBefore?.name || null,
        detail: `Shop owner approved for business ${businessId}`,
        metadata: { businessId, plan },
        req,
      });
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...result, ...detail });
    } catch (e) {
      console.error("[admin/shops] approve failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to approve shop" });
    }
  });

  router.post("/api/admin/shops/:id/reject", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    try {
      const ownerBefore = await loadShopOwnerEmail(businessId);
      const result = await rejectShop(businessId, req.body?.reason, scope.actorId);
      void logAdminActivity({
        eventType: ADMIN_ACTIVITY.ACCOUNT_DENIED,
        adminUserId: scope.actorId,
        userEmail: ownerBefore?.email || null,
        userName: ownerBefore?.name || null,
        detail: `Shop owner application denied for business ${businessId}`,
        metadata: { businessId, reason: req.body?.reason || null },
        req,
      });
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...result, ...detail });
    } catch (e) {
      console.error("[admin/shops] reject failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to reject shop" });
    }
  });

  router.patch("/api/admin/shops/:id/access", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    try {
      await updateShopAccessControls(businessId, {
        freeAccessEnabled: req.body?.freeAccessEnabled,
        paidSubscriptionRequired: req.body?.paidSubscriptionRequired,
        bookingsEnabled: req.body?.bookingsEnabled,
        paymentProcessingEnabled: req.body?.paymentProcessingEnabled,
        platformFeesEnabled: req.body?.platformFeesEnabled,
        subscriptionEnabled: req.body?.subscriptionEnabled,
        websiteAccessEnabled: req.body?.websiteAccessEnabled,
        mobileAppAccessEnabled: req.body?.mobileAppAccessEnabled,
        accessPlan: req.body?.accessPlan,
        subscriptionStatus: req.body?.subscriptionStatus,
        monthlyPrice: req.body?.monthlyPrice,
      });
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...detail });
    } catch (e) {
      console.error("[admin/shops] access patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update shop access" });
    }
  });

  router.post("/api/admin/shops/:id/trial/start", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    try {
      await startShopTrial(businessId, req.body?.trialDays);
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...detail });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to start trial" });
    }
  });

  router.post("/api/admin/shops/:id/trial/end", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    try {
      await endShopTrial(businessId);
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...detail });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Failed to end trial" });
    }
  });

  router.patch("/api/admin/shops/:id", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    if (!assertShopInScope(scope, businessId)) {
      return res.status(403).json({ ok: false, message: "That shop is outside your scope." });
    }
    try {
      const ok = await updateAdminShop(businessId, {
        name: req.body?.name ?? req.body?.shopName,
        phone: req.body?.phone,
        city: req.body?.city,
        state: req.body?.state,
        address: req.body?.address,
        plan: req.body?.plan,
        subscriptionStatus: req.body?.subscriptionStatus ?? req.body?.subscription_status,
      });
      if (!ok) return res.status(404).json({ ok: false, message: "Shop not found" });
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...detail });
    } catch (e) {
      console.error("[admin/shops] patch failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update shop" });
    }
  });

  router.patch("/api/admin/shops/:id/account-status", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!["active", "pending", "suspended"].includes(status)) {
      return res.status(400).json({ ok: false, message: "status must be active, pending, or suspended" });
    }
    try {
      const result = await setShopAccountStatus(businessId, status);
      if (!result.ok) return res.status(400).json(result);
      if (status === "suspended") {
        await updateShopAccessControls(businessId, { bookingsEnabled: false, paymentProcessingEnabled: false });
      } else if (status === "active") {
        await updateShopAccessControls(businessId, { bookingsEnabled: true, paymentProcessingEnabled: true });
      }
      const detail = await getAdminShopDetail(businessId);
      return res.json({ ok: true, ...detail });
    } catch (e) {
      console.error("[admin/shops] account-status failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to update shop status" });
    }
  });

  router.delete("/api/admin/shops/:id", async (req, res) => {
    const scope = await resolveShopManagementScope(req, res);
    if (!scope) return;
    if (!requirePlatformAdmin(scope, res)) return;
    const businessId = Number(req.params.id);
    try {
      const result = await deleteAdminShop(businessId);
      return res.json(result);
    } catch (e) {
      console.error("[admin/shops] delete failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to delete shop" });
    }
  });

  return router;
}
