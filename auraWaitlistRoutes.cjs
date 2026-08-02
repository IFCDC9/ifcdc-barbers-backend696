/**
 * Phase 3B2 waitlist + slot-offer routes — mounted on /api/aura/phase3.
 */
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraWaitlistTables } = require("./auraWaitlistMigrations.cjs");
const {
  offerWaitlistConsent,
  declineWaitlistConsent,
  listWaitlistRequests,
  getWaitlistRequestForCustomer,
  joinWaitlistWithConsent,
  updateWaitlistRequest,
  setWaitlistStatus,
  findWaitlistMatchesForSlot,
  createSlotOffer,
  listOffersForCustomer,
  declineSlotOffer,
  acceptSlotOffer,
} = require("./auraWaitlistService.cjs");

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    if (typeof mw !== "function") return resolve(true);
    mw(req, res, (err) => (err ? reject(err) : resolve(!res.headersSent)));
  });
}

/**
 * Phase 3B2 admin endpoints require platform Super Admin (or ADMIN_SECRET key).
 * Rejects shop_owner and non-super platform staff even if bookings admin guard passes.
 */
function assertWaitlistSuperAdmin(req, res) {
  const via = String(req.bookingsAdminScope?.via || "");
  if (via === "shop_owner" || req.bookingsAdminScope?.all !== true) {
    res.status(403).json({ ok: false, error: "super_admin_required" });
    return false;
  }
  if (via === "admin_key" || via === "platform_super") return true;
  if (req.user?.isSuperAdmin === true || req.user?.isOwner === true) return true;
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "super_admin") return true;
  res.status(403).json({ ok: false, error: "super_admin_required" });
  return false;
}

function attachAuraWaitlistRoutes(router, { dbQuery, requireAuth, requireAdmin } = {}) {
  router.get("/waitlist/status", (_req, res) => {
    const flags = auraPhase3Flags();
    return res.json({
      ok: true,
      feature: "phase3b2_waitlist_slot_recovery",
      waitlistEnabled: Boolean(flags.waitlist),
      slotRecoveryEnabled: Boolean(flags.waitlist && flags.slotRecovery),
      notificationsEnabled: Boolean(flags.waitlist && flags.waitlistNotifications),
      note: "Waitlist/slot recovery default OFF. Joining never books or charges. Notifications require a separate flag.",
    });
  });

  router.post("/waitlist/consent/offer", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await offerWaitlistConsent(dbQuery, {
        customerId: req.user?.id,
        criteria: req.body?.criteria || req.body,
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "consent_offer_failed" });
    }
  });

  router.post("/waitlist/consent/decline", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await declineWaitlistConsent(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "consent_decline_failed" });
    }
  });

  router.get("/waitlist/me", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await listWaitlistRequests(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "list_failed" });
    }
  });

  router.get("/waitlist/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await getWaitlistRequestForCustomer(dbQuery, {
        requestId: req.params.id,
        customerId: req.user?.id,
      });
      return res.status(out.ok ? 200 : out.error === "not_found_or_forbidden" ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "get_failed" });
    }
  });

  router.post("/waitlist", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const consentGranted =
        req.body?.consentGranted === true ||
        req.body?.consent === true ||
        String(req.body?.consent || "").toLowerCase() === "yes";
      const out = await joinWaitlistWithConsent(dbQuery, {
        customerId: req.user?.id,
        criteria: req.body?.criteria || req.body,
        consentGranted,
        source: req.body?.source || "api",
      });
      return res.status(out.ok ? 200 : out.error === "consent_required" ? 403 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "join_failed" });
    }
  });

  router.patch("/waitlist/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      if (req.body?.status === "paused" || req.body?.status === "active" || req.body?.status === "cancelled") {
        const out = await setWaitlistStatus(dbQuery, {
          requestId: req.params.id,
          customerId: req.user?.id,
          status: req.body.status,
        });
        return res.status(out.ok ? 200 : 400).json(out);
      }
      const out = await updateWaitlistRequest(dbQuery, {
        requestId: req.params.id,
        customerId: req.user?.id,
        criteria: req.body?.criteria || req.body,
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "update_failed" });
    }
  });

  router.delete("/waitlist/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().waitlist) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await setWaitlistStatus(dbQuery, {
        requestId: req.params.id,
        customerId: req.user?.id,
        status: "cancelled",
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "remove_failed" });
    }
  });

  router.get("/waitlist/offers/action", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery || !auraPhase3Flags().waitlistNotifications) {
        return res.status(404).json({ ok: false, error: "aura_phase3_waitlist_action_disabled" });
      }
      const { verifyWaitlistOfferActionToken } = require("./auraWaitlistEmails.cjs");
      const verified = verifyWaitlistOfferActionToken(req.query?.token);
      if (!verified.ok) {
        return res.status(401).json({ ok: false, error: verified.error || "invalid_token" });
      }
      const { offerId, customerId, action } = verified.payload;
      if (action === "decline") {
        const out = await declineSlotOffer(dbQuery, { offerId, customerId });
        return res.status(out.ok ? 200 : 400).json({
          ...out,
          bookingCreated: false,
          paymentTriggered: false,
          message: out.ok
            ? "Offer declined. No booking or payment was created."
            : out.message || out.error,
        });
      }
      // Accept via signed link only starts pending confirmation — never auto-books.
      const out = await acceptSlotOffer(dbQuery, {
        offerId,
        customerId,
        confirmBookingSummary: false,
        validateSlotStillAvailable: async () => ({ ok: true }),
      });
      return res.status(out.ok ? 200 : 409).json({
        ...out,
        viaSignedLink: true,
        message:
          out.message ||
          "Offer accepted pending booking summary confirmation. The slot is not booked yet.",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "action_failed" });
    }
  });

  router.get("/waitlist/offers/me", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery) {
        return res.status(404).json({ ok: false, error: "aura_phase3_slot_recovery_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await listOffersForCustomer(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "offers_failed" });
    }
  });

  router.post("/waitlist/offers/:id/decline", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery) {
        return res.status(404).json({ ok: false, error: "aura_phase3_slot_recovery_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await declineSlotOffer(dbQuery, {
        offerId: req.params.id,
        customerId: req.user?.id,
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "decline_failed" });
    }
  });

  router.post("/waitlist/offers/:id/accept", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery) {
        return res.status(404).json({ ok: false, error: "aura_phase3_slot_recovery_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await acceptSlotOffer(dbQuery, {
        offerId: req.params.id,
        customerId: req.user?.id,
        confirmBookingSummary: req.body?.confirmBookingSummary === true,
        bookingId: req.body?.bookingId || null,
        validateSlotStillAvailable: async () => ({ ok: req.body?.slotStillAvailable !== false }),
      });
      return res.status(out.ok ? 200 : 409).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "accept_failed" });
    }
  });

  // Admin/ops: scan matches / create offer for a freed slot (no auto-notify unless notifications flag on).
  router.post("/admin/waitlist/match-slot", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery) {
        return res.status(404).json({ ok: false, error: "aura_phase3_slot_recovery_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      if (!assertWaitlistSuperAdmin(req, res)) return;
      const out = await findWaitlistMatchesForSlot(dbQuery, req.body?.slot || req.body);
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "match_failed" });
    }
  });

  router.post("/admin/waitlist/offers", async (req, res) => {
    try {
      if (!auraPhase3Flags().slotRecovery) {
        return res.status(404).json({ ok: false, error: "aura_phase3_slot_recovery_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      if (!assertWaitlistSuperAdmin(req, res)) return;
      const out = await createSlotOffer(dbQuery, {
        waitlistRequestId: req.body?.waitlistRequestId,
        slot: req.body?.slot || req.body,
        ttlMinutes: req.body?.ttlMinutes,
        idempotencyKey: req.body?.idempotencyKey || null,
        validateSlotStillAvailable: async () => ({ ok: req.body?.slotStillAvailable !== false }),
      });
      return res.status(out.ok ? 201 : 409).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "offer_failed" });
    }
  });

  router.post("/admin/waitlist/migrate", async (req, res) => {
    try {
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      if (!assertWaitlistSuperAdmin(req, res)) return;
      await ensureAuraWaitlistTables(dbQuery);
      return res.json({
        ok: true,
        migrated: [
          "aura_waitlist_requests",
          "aura_waitlist_events",
          "aura_slot_offers",
          "aura_slot_offer_events",
        ],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "migrate_failed" });
    }
  });
}

module.exports = { attachAuraWaitlistRoutes };
