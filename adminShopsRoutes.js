import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  deleteAdminShop,
  getAdminShopDetail,
  listAdminShops,
  setShopAccountStatus,
  updateAdminShop,
} from "./adminShopsService.js";

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

export function createAdminShopsRouter() {
  const router = express.Router();

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
      return res.json({ ok: true, ...detail });
    } catch (e) {
      console.error("[admin/shops] detail failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Failed to load shop detail" });
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
    if (!scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can change shop account status." });
    }
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!["active", "pending", "suspended"].includes(status)) {
      return res.status(400).json({ ok: false, message: "status must be active, pending, or suspended" });
    }
    try {
      const result = await setShopAccountStatus(businessId, status);
      if (!result.ok) return res.status(400).json(result);
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
    if (!scope.isSuperAdmin && !scope.all) {
      return res.status(403).json({ ok: false, message: "Only platform admins can delete shops." });
    }
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, message: "Invalid shop id" });
    }
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
