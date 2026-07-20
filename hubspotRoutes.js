import express from "express";
import {
  cleanupPhase1TestArtifacts,
  clearHubSpotClientState,
  getHubSpotHealth,
  HUBSPOT_CANONICAL_HOST,
  HUBSPOT_CANONICAL_SERVICE_ID,
  HUBSPOT_CANONICAL_SERVICE_NAME,
  HUBSPOT_FUTURE_ENTITY_TYPES,
  isHubSpotCanonicalRuntime,
  isHubSpotCompanySyncEnabled,
  isHubSpotConfigured,
  isHubSpotDealSyncEnabled,
  isHubSpotSyncEnabled,
  listHubSpotEnvNamesPresent,
  testCompanySyncRoundTrip,
  testContactSyncRoundTrip,
  testDealSyncRoundTrip,
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
      return res.status(health.ok ? 200 : 503).json({
        ...health,
        companySyncEnabled: isHubSpotCompanySyncEnabled(),
        dealSyncEnabled: isHubSpotDealSyncEnabled(),
        canonicalRuntime: isHubSpotCanonicalRuntime(),
        canonicalService: {
          serviceId: HUBSPOT_CANONICAL_SERVICE_ID,
          serviceName: HUBSPOT_CANONICAL_SERVICE_NAME,
          host: HUBSPOT_CANONICAL_HOST,
        },
      });
    } catch (error) {
      console.warn("[hubspot] health error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        configured: isHubSpotConfigured(),
        syncEnabled: isHubSpotSyncEnabled(),
        companySyncEnabled: isHubSpotCompanySyncEnabled(),
        dealSyncEnabled: isHubSpotDealSyncEnabled(),
        authenticated: false,
        permissions: null,
        serviceKey: isHubSpotConfigured() ? "configured" : "missing",
        canonicalRuntime: isHubSpotCanonicalRuntime(),
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
      companySyncEnabled: isHubSpotCompanySyncEnabled(),
      dealSyncEnabled: isHubSpotDealSyncEnabled(),
      canonicalRuntime: isHubSpotCanonicalRuntime(),
      serviceKey: isHubSpotConfigured() ? "configured" : "missing",
      phase: isHubSpotDealSyncEnabled()
        ? "2b"
        : isHubSpotCompanySyncEnabled()
          ? "2a"
          : 1,
      phases: {
        contacts: true,
        companies: isHubSpotCompanySyncEnabled(),
        deals: isHubSpotDealSyncEnabled(),
      },
      futureEntityTypes: HUBSPOT_FUTURE_ENTITY_TYPES,
      credentialSource: "process.env.HUBSPOT_SERVICE_KEY",
      keyCached: false,
      hubspotEnvNamesPresent: listHubSpotEnvNamesPresent(),
      expectedEnvNames: [
        "HUBSPOT_SERVICE_KEY",
        "HUBSPOT_SYNC_ENABLED",
        "HUBSPOT_SYNC_COMPANIES",
        "HUBSPOT_SYNC_DEALS",
      ],
      canonicalService: {
        serviceId: HUBSPOT_CANONICAL_SERVICE_ID,
        serviceName: HUBSPOT_CANONICAL_SERVICE_NAME,
        host: HUBSPOT_CANONICAL_HOST,
      },
    });
  });

  /** POST /api/hubspot/verify — admin-only explicit auth + permission probe. */
  router.post("/verify", ...adminHandlers, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      clearHubSpotClientState();
      const result = await verifyHubSpotAuthentication({ includePermissions: true });
      return res.status(result.ok && result.authenticated ? 200 : 503).json({
        ...result,
        companySyncEnabled: isHubSpotCompanySyncEnabled(),
        canonicalRuntime: isHubSpotCanonicalRuntime(),
      });
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

  /**
   * POST /api/hubspot/test-company — admin-only company upsert round-trip by businessId.
   * Body: { businessId }
   */
  router.post("/test-company", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const businessId = Number(req.body?.businessId);
      if (!Number.isFinite(businessId) || businessId <= 0) {
        return res.status(400).json({ ok: false, message: "businessId is required" });
      }
      const result = await testCompanySyncRoundTrip(businessId);
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      console.warn("[hubspot] test-company error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        message: "HubSpot company test failed",
      });
    }
  });

  /**
   * POST /api/hubspot/test-deal — admin-only deal upsert round-trip by bookingId.
   * Body: { bookingId }
   */
  router.post("/test-deal", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const bookingId = String(req.body?.bookingId || "").trim();
      if (!bookingId) {
        return res.status(400).json({ ok: false, message: "bookingId is required" });
      }
      const result = await testDealSyncRoundTrip(bookingId);
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      console.warn("[hubspot] test-deal error:", error?.message || error);
      return res.status(503).json({
        ok: false,
        message: "HubSpot deal test failed",
      });
    }
  });

  /**
   * POST /api/hubspot/cleanup-phase1-tests — admin-only removal of Phase 1 verification artifacts.
   */
  router.post("/cleanup-phase1-tests", ...adminHandlers, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const result = await cleanupPhase1TestArtifacts({ deleteAppUsers: true });
      return res.status(result.ok ? 200 : 207).json(result);
    } catch (error) {
      console.warn("[hubspot] cleanup-phase1-tests error:", error?.message || error);
      return res.status(503).json({ ok: false, message: "Phase 1 cleanup failed" });
    }
  });

  return router;
}
