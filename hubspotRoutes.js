import express from "express";
import {
  cleanupPhase1TestArtifacts,
  clearHubSpotClientState,
  enqueueCompanySyncById,
  enqueueDealSyncById,
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
  isHubSpotWorkflowSyncEnabled,
  listHubSpotEnvNamesPresent,
  testCompanySyncRoundTrip,
  testContactSyncRoundTrip,
  testDealSyncRoundTrip,
  verifyHubSpotAuthentication,
} from "./hubspotService.js";
import { isHubSpotHqAnalyticsEnabled } from "./hubspotAnalyticsService.js";
import { dbQuery } from "./db.js";
import {
  ensurePhase2cHubSpotSetup,
  getLastPhase2cSetupSummary,
  maybeRerunPhase2cSetup,
  runSafeHubSpotMappingBackfill,
} from "./hubspotPhase2cSetupService.js";
import { getStarterAutomationCatalog } from "./hubspotStarterAutomationService.js";

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
        workflowSyncEnabled: isHubSpotWorkflowSyncEnabled(),
        analyticsEnabled: isHubSpotHqAnalyticsEnabled(),
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
        workflowSyncEnabled: isHubSpotWorkflowSyncEnabled(),
        analyticsEnabled: isHubSpotHqAnalyticsEnabled(),
        authenticated: false,
        permissions: null,
        serviceKey: isHubSpotConfigured() ? "configured" : "missing",
        canonicalRuntime: isHubSpotCanonicalRuntime(),
        message: "HubSpot health check failed",
      });
    }
  });

  /** GET /api/hubspot/status — lightweight flags without live HubSpot call. */
  router.get("/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    const refresh = String(req.query?.refreshSetup || "").trim() === "1";
    if (refresh) {
      void maybeRerunPhase2cSetup({ force: true, enableWorkflows: false });
    } else {
      void maybeRerunPhase2cSetup({ enableWorkflows: false });
    }
    res.json({
      ok: true,
      configured: isHubSpotConfigured(),
      syncEnabled: isHubSpotSyncEnabled(),
      companySyncEnabled: isHubSpotCompanySyncEnabled(),
      dealSyncEnabled: isHubSpotDealSyncEnabled(),
      workflowSyncEnabled: isHubSpotWorkflowSyncEnabled(),
      analyticsEnabled: isHubSpotHqAnalyticsEnabled(),
      canonicalRuntime: isHubSpotCanonicalRuntime(),
      serviceKey: isHubSpotConfigured() ? "configured" : "missing",
      phase: isHubSpotHqAnalyticsEnabled()
        ? "2d"
        : isHubSpotWorkflowSyncEnabled()
          ? "2c"
          : isHubSpotDealSyncEnabled()
            ? "2b"
            : isHubSpotCompanySyncEnabled()
              ? "2a"
              : 1,
      phases: {
        contacts: true,
        companies: isHubSpotCompanySyncEnabled(),
        deals: isHubSpotDealSyncEnabled(),
        workflows: isHubSpotWorkflowSyncEnabled(),
        analytics: isHubSpotHqAnalyticsEnabled(),
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
        "HUBSPOT_SYNC_WORKFLOWS",
        "HUBSPOT_HQ_ANALYTICS",
      ],
      canonicalService: {
        serviceId: HUBSPOT_CANONICAL_SERVICE_ID,
        serviceName: HUBSPOT_CANONICAL_SERVICE_NAME,
        host: HUBSPOT_CANONICAL_HOST,
      },
      phase2cSetup: (() => {
        const s = getLastPhase2cSetupSummary();
        if (!s) return null;
        const propErrors = (s.properties || []).filter((p) => p.status === "error").slice(0, 3);
        const emailErrors = (s.emails || []).filter((e) => e.status === "error").slice(0, 3);
        const flowErrors = (s.workflows || []).filter((w) => w.status === "error").slice(0, 3);
        return {
          ok: s.ok,
          ranAt: s.ranAt,
          portalId: s.portalId || null,
          subscriptionMode: s.subscriptionMode || null,
          workflowProvisionMode: s.workflowProvisionMode || null,
          professionalBlocker: s.professionalBlocker
            ? {
                feature: s.professionalBlocker.feature,
                requiredPlan: s.professionalBlocker.requiredPlan,
                endpoints: s.professionalBlocker.endpoints,
                starterFallback: s.professionalBlocker.starterFallback,
                liveEvidence: s.professionalBlocker.liveEvidence || null,
              }
            : null,
          propertyOk: (s.properties || []).filter((p) => p.status === "exists" || p.status === "created").length,
          propertyTotal: (s.properties || []).length,
          emailOk: (s.emails || []).filter((e) => e.id).length,
          emailTotal: (s.emails || []).length,
          workflowOk: (s.workflows || []).filter((w) =>
            ["exists", "created", "starter_manual", "manual_ui_or_simple_automations"].includes(
              String(w.status || ""),
            ),
          ).length,
          workflowApiOk: (s.workflows || []).filter((w) =>
            ["exists", "created"].includes(String(w.status || "")),
          ).length,
          workflowEnabled: (s.workflows || []).filter((w) => w.enabled).length,
          workflowTotal: (s.workflows || []).length,
          notes: s.notes || [],
          tokenFingerprint: s.tokenFingerprint || s.tokenScopes?.fingerprint || null,
          automationProbe: s.automationProbe || null,
          automationSurfaces: s.automationSurfaces || null,
          tokenScopes: s.tokenScopes
            ? {
                ok: s.tokenScopes.ok,
                http: s.tokenScopes.http,
                endpoint: s.tokenScopes.endpoint || null,
                hasAutomation: s.tokenScopes.hasAutomation,
                hasWorkflowsPublicApi: s.tokenScopes.hasWorkflowsPublicApi || false,
                scopes: s.tokenScopes.scopes || [],
                hubId: s.tokenScopes.hubId || null,
                appId: s.tokenScopes.appId || null,
                userId: s.tokenScopes.userId || null,
                fingerprint: s.tokenScopes.fingerprint || s.tokenFingerprint || null,
                message: s.tokenScopes.message || null,
              }
            : null,
          errorSamples: {
            properties: propErrors.map((p) => ({
              name: p.name,
              http: p.http || null,
              message: p.message || null,
            })),
            emails: emailErrors.map((e) => ({
              name: e.name,
              http: e.http || null,
              message: e.message || null,
            })),
            workflows: flowErrors.map((w) => ({
              name: w.name,
              endpoint: w.endpoint || "POST /automation/v4/flows",
              http: w.http || null,
              category: w.category || null,
              subCategory: w.subCategory || null,
              message: w.message || null,
              requiredScopes: w.requiredScopes || [],
              correlationId: w.correlationId || null,
              errorMessages: w.errorMessages || [],
              hubspotBody: w.hubspotBody || null,
            })),
          },
          workflows: (s.workflows || []).map((w) => ({
            name: w.name,
            key: w.key || null,
            status: w.status,
            provisionMode: w.provisionMode || null,
            enabled: Boolean(w.enabled),
            emailId: w.emailId || null,
            emailName: w.emailName || null,
            id: w.id || null,
          })),
          starterAutomations: getStarterAutomationCatalog(),
        };
      })(),
      setupRefreshRequested: refresh,
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

  /**
   * POST /api/hubspot/backfill — admin-only controlled company/deal enqueue.
   * Body: { companies?: boolean, deals?: boolean, limit?: number }
   */
  router.post("/backfill", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const limit = Math.min(Math.max(Number(req.body?.limit) || 25, 1), 100);
      const wantCompanies = req.body?.companies !== false;
      const wantDeals = req.body?.deals !== false;
      const queued = { companies: [], deals: [] };

      if (wantCompanies && isHubSpotCompanySyncEnabled()) {
        const rows = await dbQuery(
          `SELECT b.id
           FROM businesses b
           LEFT JOIN hubspot_sync_companies m ON m.business_id = b.id
           WHERE m.business_id IS NULL
              OR m.hubspot_company_id IS NULL
              OR m.last_sync_status IS DISTINCT FROM 'synced'
           ORDER BY b.id ASC
           LIMIT $1`,
          [limit],
        );
        for (const row of rows.rows || []) {
          enqueueCompanySyncById(row.id, { reason: "admin_backfill" });
          queued.companies.push(row.id);
        }
      }

      if (wantDeals && isHubSpotDealSyncEnabled()) {
        const rows = await dbQuery(
          `SELECT b.id::text AS id
           FROM bookings b
           LEFT JOIN hubspot_sync_deals m ON m.booking_id = b.id
           WHERE (
             b.is_paid_booking = true
             OR lower(coalesce(b.payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'captured', 'deposit_paid')
             OR lower(coalesce(b.booking_status, '')) IN ('completed', 'cancelled', 'no_show', 'confirmed')
           )
             AND lower(coalesce(b.booking_status, '')) IS DISTINCT FROM 'pending_payment'
             AND (
               m.booking_id IS NULL
               OR m.hubspot_deal_id IS NULL
               OR m.last_sync_status IS DISTINCT FROM 'synced'
             )
           ORDER BY coalesce(b.completed_at, b.created_at) DESC NULLS LAST
           LIMIT $1`,
          [limit],
        );
        for (const row of rows.rows || []) {
          enqueueDealSyncById(row.id, { reason: "admin_backfill" });
          queued.deals.push(row.id);
        }
      }

      return res.status(200).json({
        ok: true,
        limit,
        queuedCompanyCount: queued.companies.length,
        queuedDealCount: queued.deals.length,
        companySyncEnabled: isHubSpotCompanySyncEnabled(),
        dealSyncEnabled: isHubSpotDealSyncEnabled(),
      });
    } catch (error) {
      console.warn("[hubspot] backfill error:", error?.message || error);
      return res.status(503).json({ ok: false, message: "HubSpot backfill failed" });
    }
  });

  /**
   * POST /api/hubspot/setup-phase2c — admin-only ensure properties/emails/workflows.
   * Body: { enableWorkflows?: boolean, backfill?: boolean, limit?: number }
   */
  router.post("/setup-phase2c", ...adminHandlers, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const enableWorkflows = req.body?.enableWorkflows === true;
      const setup = await ensurePhase2cHubSpotSetup({ enableWorkflows });
      let backfill = null;
      if (req.body?.backfill) {
        backfill = await runSafeHubSpotMappingBackfill({
          limit: Number(req.body?.limit) || 25,
        });
      }
      return res.status(setup.ok ? 200 : 207).json({
        ok: setup.ok,
        setup: {
          ranAt: setup.ranAt,
          portalId: setup.portalId || null,
          subscriptionMode: setup.subscriptionMode || null,
          workflowProvisionMode: setup.workflowProvisionMode || null,
          professionalBlocker: setup.professionalBlocker || null,
          tokenFingerprint: setup.tokenFingerprint || null,
          tokenScopes: setup.tokenScopes
            ? {
                ok: setup.tokenScopes.ok,
                http: setup.tokenScopes.http,
                endpoint: setup.tokenScopes.endpoint || null,
                hasAutomation: setup.tokenScopes.hasAutomation,
                hasWorkflowsPublicApi: setup.tokenScopes.hasWorkflowsPublicApi || false,
                scopes: setup.tokenScopes.scopes || [],
                hubId: setup.tokenScopes.hubId || null,
                appId: setup.tokenScopes.appId || null,
                fingerprint: setup.tokenScopes.fingerprint || null,
                message: setup.tokenScopes.message || null,
              }
            : null,
          automationProbe: setup.automationProbe || null,
          automationSurfaces: setup.automationSurfaces || null,
          properties: setup.properties,
          emails: (setup.emails || []).map((e) => ({
            name: e.name,
            status: e.status,
            id: e.id || null,
            state: e.state || null,
            http: e.http || null,
            message: e.message || null,
          })),
          workflows: setup.workflows,
          notes: setup.notes,
        },
        backfill,
      });
    } catch (error) {
      console.warn("[hubspot] setup-phase2c error:", error?.message || error);
      return res.status(503).json({ ok: false, message: "Phase 2C setup failed" });
    }
  });

  return router;
}
