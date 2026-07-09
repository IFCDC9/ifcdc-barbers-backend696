import express from "express";
import { requireAuth } from "./authRoutes.js";
import { resolveScopedBarberId } from "./barberScope.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import {
  deleteBarberReward,
  getOrCreateLoyaltyAccount,
  listActiveRewards,
  listLoyaltyTransactions,
  listRewardsForBarberManage,
  redeemLoyaltyReward,
  upsertBarberReward,
} from "./loyaltyService.js";

async function middlewareBarberScope(req, res, next) {
  try {
    const q = String(req.query?.barberId ?? req.query?.barber_id ?? req.body?.barberId ?? "").trim();
    const resolved = await resolveScopedBarberId(req.user, q || undefined);
    if (resolved.error) {
      return res.status(resolved.status).json({ ok: false, error: resolved.error, message: resolved.message });
    }
    req.barberId = resolved.barberId;
    return next();
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || String(e) });
  }
}

export function createLoyaltyRouter() {
  const router = express.Router();

  router.get("/api/loyalty/me", requireAuth, async (req, res) => {
    try {
      const userId = String(req.user.id);
      const barberId = req.user?.barberId ?? req.user?.barber_id ?? null;
      const [account, transactions, rewards] = await Promise.all([
        getOrCreateLoyaltyAccount(userId),
        listLoyaltyTransactions(userId, 40),
        listActiveRewards({ barberId }),
      ]);
      return res.json({
        ok: true,
        points: Number(account?.points_balance) || 0,
        lifetimeEarned: Number(account?.lifetime_earned) || 0,
        transactions,
        rewards,
      });
    } catch (e) {
      console.error("[loyalty] GET /me:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  router.post("/api/loyalty/redeem", requireAuth, async (req, res) => {
    try {
      const rewardId = String(req.body?.rewardId ?? req.body?.reward_id ?? "").trim();
      const result = await redeemLoyaltyReward(req.user.id, rewardId);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[loyalty] POST /redeem:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Redemption failed." });
    }
  });

  router.get("/api/barber/loyalty/rewards", requireAuth, middlewareBarberScope, async (req, res) => {
    try {
      const rewards = await listRewardsForBarberManage(req.barberId);
      return res.json({ ok: true, rewards });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  router.post("/api/barber/loyalty/rewards", requireAuth, middlewareBarberScope, async (req, res) => {
    try {
      const result = await upsertBarberReward(req.barberId, req.body || {});
      if (!result.ok) return res.status(400).json(result);
      return res.status(201).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Could not save reward." });
    }
  });

  router.put("/api/barber/loyalty/rewards/:id", requireAuth, middlewareBarberScope, async (req, res) => {
    try {
      const result = await upsertBarberReward(req.barberId, req.body || {}, req.params.id);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Could not update reward." });
    }
  });

  router.delete("/api/barber/loyalty/rewards/:id", requireAuth, middlewareBarberScope, async (req, res) => {
    try {
      const result = await deleteBarberReward(req.barberId, req.params.id);
      if (!result.ok) return res.status(404).json(result);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Could not delete reward." });
    }
  });

  router.get("/api/admin/loyalty/rewards", requireAuth, async (req, res) => {
    const role = String(req.user?.role || "").toLowerCase();
    if (!isJwtGlobalSuperScope(req.user) && role !== "admin" && role !== "super_admin") {
      return res.status(403).json({ ok: false, message: "Access denied." });
    }
    try {
      const { listActiveRewards: listAll } = await import("./loyaltyService.js");
      const { dbQuery } = await import("./db.js");
      const r = await dbQuery(
        `SELECT id, barber_id, title, description, points_cost, is_active, created_at, updated_at
         FROM loyalty_rewards ORDER BY created_at DESC`,
      );
      return res.json({ ok: true, rewards: r.rows || [] });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Could not load rewards." });
    }
  });

  return router;
}
