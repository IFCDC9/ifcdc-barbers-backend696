import express from "express";
import {
  clearHubSpotClientState,
  getHubSpotHealth,
  HUBSPOT_FUTURE_ENTITY_TYPES,
  isHubSpotConfigured,
  isHubSpotSyncEnabled,
  testContactSyncRoundTrip,
  verifyHubSpotAuthentication,
} from "./hubspotService.js";

/**
 * HubSpot integration routes — server-side only.
 * Health responses never include HUBSPOT_SERVICE_KEY.
 */
export function createHubSpotRouter({ requireAuth = null, requireAdmin = null } = {}) {
  const router = express.Router();

  const adminHandlers = [];
  if (typeof requireAuth === "function") adminHandlers.push(requireAuth);
  if (typeof requireAdmin === "function") adminHandlers.push(requireAdmin);

  /** GET /api/hubspot/health — connectivity + CRM permission probes (no secrets). */
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
        permissions: null,
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
      credentialSource: "process.env.HUBSPOT_SERVICE_KEY",
      keyCached: false,
    });
  });

  /** POST /api/hubspot/verify — admin-only explicit auth + permission probe. */
  router.post("/verify", ...adminHandlers, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      clearHubSpotClientState();
      const result = await verifyHubSpotAuthentication({ includePermissions: true });
      return res.status(result.ok && result.authenticated ? 200 : 503).json(result);
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

  /**
   * POST /api/hubspot/test-contact — admin-only create + update round-trip by email.
   * Body: { email?, name?, phone? }
   */
  router.post("/test-contact", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const email =
        String(req.body?.email || "").trim()
        || `hubspot.phase1.${Date.now()}@ifcdcbarbersapp.com`;
      const result = await testContactSyncRoundTrip({
        email,
        name: String(req.body?.name || "IFCDC HubSpot Phase1 Test").trim(),
        phone: String(req.body?.phone || "").trim(),
      });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      console.warn("[hubspot] test-contact error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        message: "HubSpot contact test failed",
      });
    }
  });

  return router;
}
