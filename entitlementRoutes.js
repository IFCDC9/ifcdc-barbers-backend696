import express from "express";
import { requireAuth } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import { catalogPublic, GOOGLE_PACKAGE_NAME, APPLE_BUNDLE_ID } from "./monetizationCatalog.js";
import { entitlementsMode } from "./entitlementFlags.js";
import { loadEntitlementsForUser, listSubscriptionsForAdmin } from "./entitlementService.js";
import { confirmAppleTransaction, processAppleAssnV2 } from "./appleAssnService.js";
import { confirmGooglePurchase, processGoogleRtdn } from "./googleRtdnService.js";
import { getStoreVerifiers, storeVerifyStatus, probeAppleStoreKitAuth } from "./storeVerifyAdapters.js";
import { appleHealthPublic } from "./appleStoreKitClient.js";
import { ensureEntitlementSchema } from "./entitlementMigrations.js";

function actorUserId(req) {
  return req.user?.id || req.user?.sub || null;
}

export function createEntitlementRouter(deps = {}) {
  const query = deps.dbQuery || dbQuery;
  const verifiers = getStoreVerifiers(deps.verifiers || {});
  const router = express.Router();

  router.get("/api/entitlements/catalog", (_req, res) => {
    res.json({ ok: true, mode: entitlementsMode(), catalog: catalogPublic(), verify: storeVerifyStatus() });
  });

  router.get("/api/billing/apple/health", async (_req, res) => {
    try {
      const probe = await probeAppleStoreKitAuth({ fetchImpl: deps.fetchImpl || globalThis.fetch });
      return res.json(appleHealthPublic(probe));
    } catch (e) {
      console.error("[billing/apple/health]", e?.message || e);
      return res.status(500).json({
        appleConfigured: false,
        appleApiAuth: "fail",
        environment: "unconfigured",
        errorClass: "health_failed",
      });
    }
  });

  router.get("/api/entitlements/me", requireAuth, async (req, res) => {
    try {
      const snapshot = await loadEntitlementsForUser(req.user, { dbQuery: query });
      if (req.body?.status || req.query.status) {
        snapshot.clientStatusIgnored = true;
      }
      return res.json({ ok: true, entitlements: snapshot });
    } catch (e) {
      console.error("[entitlements/me]", e?.message || e);
      return res.status(500).json({ ok: false, error: "entitlements_failed" });
    }
  });

  router.post("/api/billing/confirm", requireAuth, async (req, res) => {
    try {
      const platform = String(req.body?.platform || "").toLowerCase();
      const productId = String(req.body?.productId || "").trim();
      const claimedStatus = req.body?.status;
      const userId = actorUserId(req);
      const businessId = req.body?.businessId != null ? Number(req.body.businessId) : req.user?.businessId || null;

      if (platform === "apple") {
        const result = await confirmAppleTransaction({
          transactionJws: req.body?.transactionJws || req.body?.signedTransactionInfo,
          verifyTransactionJws: verifiers.verifyAppleTransactionJws,
          userId,
          businessId: Number.isFinite(businessId) ? businessId : null,
          dbQuery: query,
          claimedProductId: productId,
          claimedStatus,
        });
        if (!result.ok) return res.status(400).json(result);
        const entitlements = await loadEntitlementsForUser(req.user, { dbQuery: query });
        return res.json({ ok: true, ...result, entitlements, clientStatusIgnored: true });
      }

      if (platform === "google") {
        const pkg = String(req.body?.packageName || GOOGLE_PACKAGE_NAME).trim();
        if (pkg !== GOOGLE_PACKAGE_NAME) {
          return res.status(400).json({ ok: false, error: "package_mismatch" });
        }
        const result = await confirmGooglePurchase({
          productId,
          purchaseToken: String(req.body?.purchaseToken || "").trim(),
          packageName: pkg,
          userId,
          businessId: Number.isFinite(businessId) ? businessId : null,
          dbQuery: query,
          verifySubscription: verifiers.verifyGoogleSubscription,
          verifyOneTime: verifiers.verifyGoogleOneTime,
          restored: req.body?.restored === true,
          claimedStatus,
        });
        if (!result.ok) return res.status(400).json(result);
        return res.json({ ok: true, ...result, clientStatusIgnored: true });
      }

      return res.status(400).json({ ok: false, error: "unsupported_platform" });
    } catch (e) {
      console.error("[billing/confirm]", e?.message || e);
      return res.status(500).json({ ok: false, error: "confirm_failed" });
    }
  });

  router.post("/api/billing/apple/assn", async (req, res) => {
    try {
      const signedPayload = req.body?.signedPayload || req.body?.signed_payload;
      const result = await processAppleAssnV2({
        signedPayload,
        dbQuery: query,
        verifySignedPayload: verifiers.verifyAppleSignedPayload,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(200).json({ ok: true, received: true, notificationType: result.notificationType });
    } catch (e) {
      console.error("[billing/apple/assn]", e?.message || e);
      return res.status(500).json({ ok: false, error: "assn_failed" });
    }
  });

  router.post("/api/billing/google/rtdn", async (req, res) => {
    try {
      const result = await processGoogleRtdn({
        body: req.body || {},
        dbQuery: query,
        verifySubscription: verifiers.verifyGoogleSubscription,
        verifyOneTime: verifiers.verifyGoogleOneTime,
      });
      if (!result.ok) return res.status(400).json(result);
      return res.status(200).json({ ok: true, received: true });
    } catch (e) {
      console.error("[billing/google/rtdn]", e?.message || e);
      return res.status(500).json({ ok: false, error: "rtdn_failed" });
    }
  });

  router.get("/api/admin/entitlements/subscriptions", requireAuth, async (req, res) => {
    if (!isJwtGlobalSuperScope(req.user)) {
      return res.status(403).json({
        ok: false,
        error: "super_admin_required",
        message: "Managers cannot view or change platform subscriptions, pricing, or credentials.",
      });
    }
    try {
      const data = await listSubscriptionsForAdmin(query);
      return res.json({ ok: true, ...data });
    } catch (e) {
      console.error("[admin/entitlements]", e?.message || e);
      return res.status(500).json({ ok: false, error: "admin_entitlements_failed" });
    }
  });

  return router;
}

export async function bootEntitlementSchema(dbQueryFn = dbQuery) {
  return ensureEntitlementSchema(dbQueryFn);
}

export const BILLING_APPLE_BUNDLE_ID = APPLE_BUNDLE_ID;
