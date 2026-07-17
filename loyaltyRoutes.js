import express from "express";
import { requireAuth } from "./authRoutes.js";
import { resolveScopedBarberId } from "./barberScope.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  deleteBarberReward,
  deleteReward,
  getLoyaltyAdminReport,
  getLoyaltyDashboard,
  listRewardsForBarberManage,
  manualLoyaltyAdjustment,
  redeemLoyaltyReward,
  upsertBarberReward,
  upsertReward,
} from "./loyaltyService.js";

function isAdmin(user) {
  const role = String(user?.role || "").toLowerCase();
  return isJwtGlobalSuperScope(user) || role === "admin" || role === "super_admin";
}

function requireLoyaltyAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ ok: false, message: "Access denied." });
  return next();
}

async function middlewareBarberScope(req, res, next) {
  try {
    const queryId = String(
      req.query?.barberId ?? req.query?.barber_id ?? req.body?.barberId ?? req.body?.barber_id ?? "",
    ).trim();
    const resolved = await resolveScopedBarberId(req.user, queryId || undefined);
    if (resolved.error) {
      return res.status(resolved.status).json({
        ok: false,
        error: resolved.error,
        message: resolved.message,
      });
    }
    req.barberId = resolved.barberId;
    return next();
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || String(error) });
  }
}

export function createLoyaltyRouter() {
  const router = express.Router();

  router.get("/api/loyalty/me", requireAuth, async (req, res) => {
    try {
      const userId = String(req.user?.id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid session" });
      }
      const barberId = req.query?.barberId ?? req.query?.barber_id ?? null;
      const dashboard = await getLoyaltyDashboard(userId, { barberId });
      return res.json({ ok: true, ...dashboard });
    } catch (error) {
      console.error("[loyalty] GET /me:", error?.stack || error);
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  // Kept for old clients; direct redemption is blocked by policy.
  router.post("/api/loyalty/redeem", requireAuth, async (req, res) => {
    const result = await redeemLoyaltyReward(req.user.id, req.body?.rewardId);
    return res.status(409).json(result);
  });

  router.get("/api/barber/loyalty/rewards", requireAuth, middlewareBarberScope, async (req, res) => {
    try {
      const rewards = await listRewardsForBarberManage(req.barberId);
      return res.json({ ok: true, rewards });
    } catch (error) {
      console.error("[loyalty] barber rewards:", error?.message || error);
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  router.post("/api/barber/loyalty/rewards", requireAuth, middlewareBarberScope, async (req, res) => {
    const result = await upsertBarberReward(req.barberId, req.body || {}, null, req.user);
    return res.status(result.ok ? 201 : 400).json(result);
  });

  router.put("/api/barber/loyalty/rewards/:id", requireAuth, middlewareBarberScope, async (req, res) => {
    const result = await upsertBarberReward(req.barberId, req.body || {}, req.params.id, req.user);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.delete("/api/barber/loyalty/rewards/:id", requireAuth, middlewareBarberScope, async (req, res) => {
    const result = await deleteBarberReward(req.barberId, req.params.id, req.user);
    return res.status(result.ok ? 200 : 404).json(result);
  });

  router.get("/api/admin/loyalty/rewards", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    try {
      const includeDeleted = String(req.query?.includeDeleted || "") === "true";
      const result = await dbQuery(
        `SELECT id, barber_id, business_id, reward_key, title, description, points_cost, reward_type,
                reward_value, eligible_services, eligible_barbers, expires_at, quantity_limit,
                quantity_redeemed, is_active, is_deleted, metadata, created_by, updated_by,
                created_at, updated_at
         FROM loyalty_rewards
         WHERE ($1::boolean = true OR is_deleted = false)
         ORDER BY points_cost ASC, created_at DESC`,
        [includeDeleted],
      );
      return res.json({ ok: true, rewards: result.rows || [] });
    } catch (error) {
      console.error("[loyalty] admin rewards:", error?.message || error);
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  router.post("/api/admin/loyalty/rewards", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    const result = await upsertReward({
      payload: req.body || {},
      barberId: req.body?.barber_id ?? req.body?.barberId ?? null,
      businessId: req.body?.business_id ?? req.body?.businessId ?? null,
      actor: req.user,
    });
    return res.status(result.ok ? 201 : 400).json(result);
  });

  router.put("/api/admin/loyalty/rewards/:id", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    const result = await upsertReward({
      payload: req.body || {},
      rewardId: req.params.id,
      barberId: req.body?.barber_id ?? req.body?.barberId ?? null,
      businessId: req.body?.business_id ?? req.body?.businessId ?? null,
      actor: req.user,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.patch("/api/admin/loyalty/rewards/:id/status", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    try {
      const result = await dbQuery(
        `UPDATE loyalty_rewards
         SET is_active = $2, updated_by = $3, updated_at = NOW()
         WHERE id = $1::uuid AND is_deleted = false
         RETURNING *`,
        [req.params.id, Boolean(req.body?.is_active ?? req.body?.isActive), String(req.user?.email || req.user?.id)],
      );
      if (!result.rows.length) return res.status(404).json({ ok: false, message: "Reward not found." });
      await dbQuery(
        `INSERT INTO loyalty_audit_logs
           (actor_user_id, actor_label, action, target_type, target_id, after_data)
         VALUES ($1::uuid, $2, 'reward_status_changed', 'reward', $3, $4::jsonb)`,
        [req.user.id, String(req.user.email || req.user.id), req.params.id, JSON.stringify(result.rows[0])],
      );
      return res.json({ ok: true, reward: result.rows[0] });
    } catch (error) {
      return res.status(500).json({ ok: false, message: error?.message || "Could not update reward." });
    }
  });

  router.delete("/api/admin/loyalty/rewards/:id", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    const result = await deleteReward(req.params.id, { actor: req.user });
    return res.status(result.ok ? 200 : 404).json(result);
  });

  router.get("/api/admin/loyalty/report", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    try {
      const report = await getLoyaltyAdminReport({ limit: req.query?.limit });
      return res.json({ ok: true, ...report });
    } catch (error) {
      console.error("[loyalty] report:", error?.stack || error);
      return res.status(500).json({ ok: false, message: "Could not load loyalty reporting." });
    }
  });

  router.post("/api/admin/loyalty/adjustments", requireAuth, requireLoyaltyAdmin, async (req, res) => {
    let userId = String(req.body?.userId ?? req.body?.user_id ?? "").trim();
    const email = String(req.body?.email ?? "").trim();
    if (!userId && email) {
      const found = await dbQuery(
        `SELECT id FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
        [email],
      );
      userId = String(found.rows?.[0]?.id || "");
    }
    if (!userId) return res.status(400).json({ ok: false, message: "Customer user ID or email is required." });
    const result = await manualLoyaltyAdjustment(userId, req.body?.delta, {
      actor: req.user,
      reason: req.body?.reason,
      metadata: { note: req.body?.note || null },
    });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  return router;
}
