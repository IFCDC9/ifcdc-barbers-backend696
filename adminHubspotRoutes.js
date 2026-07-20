import express from "express";
import { getHubSpotHqKpis, isHubSpotHqAnalyticsEnabled } from "./hubspotAnalyticsService.js";

/**
 * Admin HubSpot HQ analytics — Phase 2D.
 * Mount at /api/admin/hubspot
 */
export function createAdminHubSpotRouter({ requireAuth = null, requireAdmin = null } = {}) {
  const router = express.Router();
  const adminHandlers = [];
  if (typeof requireAuth === "function") adminHandlers.push(requireAuth);
  if (typeof requireAdmin === "function") adminHandlers.push(requireAdmin);

  /**
   * GET /api/admin/hubspot/kpis?days=30
   * Aggregated HQ metrics (local + HubSpot sync health). No secrets.
   */
  router.get("/kpis", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const days = Number(req.query?.days) || 30;
      const payload = await getHubSpotHqKpis({ days });
      return res.status(200).json(payload);
    } catch (error) {
      console.warn("[hubspot] hq kpis error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        enabled: isHubSpotHqAnalyticsEnabled(),
        message: "HubSpot HQ analytics unavailable",
      });
    }
  });

  return router;
}
