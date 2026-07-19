import express from "express";
import {
  getHubSpotHealth,
  HUBSPOT_FUTURE_ENTITY_TYPES,
  isHubSpotConfigured,
  isHubSpotSyncEnabled,
  verifyHubSpotAuthentication,
} from "./hubspotService.js";

/**
 * HubSpot integration routes — server-side only.
 * Health responses never include HUBSPOT_SERVICE_KEY.
 */
export function createHubSpotRouter({ requireAuth = null, requireAdmin = null } = {}) {
  const router = express.Router();

  /** GET /api/hubspot/health — connectivity + flag status (no secrets). */
  router.get("/health", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const health = await getHubSpotHealth();
      return res.status(health.ok ? 200 : 503).json(health);
    } catch (error) {
      console.warn("[hubspot] health error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        configured: isHubSpotConfigured(),
        syncEnabled: isHubSpotSyncEnabled(),
        authenticated: false,
        serviceKey: isHubSpotConfigured() ? "configured" : "missing",
        message: "HubSpot health check failed",
      });
    }
  });

  /** GET /api/hubspot/status — lightweight flags without live HubSpot call. */
  router.get("/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      configured: isHubSpotConfigured(),
      syncEnabled: isHubSpotSyncEnabled(),
      serviceKey: isHubSpotConfigured() ? "configured" : "missing",
      phase: 1,
      futureEntityTypes: HUBSPOT_FUTURE_ENTITY_TYPES,
    });
  });

  /**
   * POST /api/hubspot/verify — admin-only explicit auth probe.
   * Falls back to public (still no secrets) if admin middleware is not wired.
   */
  const verifyHandlers = [];
  if (typeof requireAuth === "function") verifyHandlers.push(requireAuth);
  if (typeof requireAdmin === "function") verifyHandlers.push(requireAdmin);
  router.post("/verify", ...verifyHandlers, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const result = await verifyHubSpotAuthentication();
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      console.warn("[hubspot] verify error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        configured: isHubSpotConfigured(),
        syncEnabled: isHubSpotSyncEnabled(),
        authenticated: false,
        message: "HubSpot verification failed",
      });
    }
  });

  return router;
}
