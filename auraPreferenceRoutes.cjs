/**
 * Phase 3B1 preference routes — mounted on /api/aura/phase3 when master flag is on.
 * Customer routes require auth + ownership. Admin routes review/remove only.
 */
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraPreferenceTables } = require("./auraPreferenceMigrations.cjs");
const {
  offerPreferenceConsent,
  declinePreferenceConsent,
  listCustomerPreferences,
  getPreferenceForCustomer,
  savePreferenceWithConsent,
  deletePreference,
  deleteAllPreferences,
  withdrawConsent,
  buildPreferenceSuggestions,
  respondToPreferenceSuggestion,
  assertPreferenceDoesNotOverride,
  adminListPreferences,
} = require("./auraPreferenceService.cjs");
const { ALLOWED_PREFERENCE_TYPES } = require("./auraPreferenceSecurity.cjs");

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    if (typeof mw !== "function") return resolve(true);
    mw(req, res, (err) => (err ? reject(err) : resolve(!res.headersSent)));
  });
}

function attachAuraPreferenceRoutes(router, { dbQuery, requireAuth, requireAdmin } = {}) {
  router.get("/preferences/status", (_req, res) => {
    const flags = auraPhase3Flags();
    return res.json({
      ok: true,
      feature: "phase3b1_customer_preferences",
      enabled: Boolean(flags.customerPreferences),
      suggestionsEnabled: Boolean(flags.preferenceSuggestions),
      allowedTypes: [...ALLOWED_PREFERENCE_TYPES],
      note: "Preferences default OFF. Consent required before save. Never auto-books.",
    });
  });

  router.post("/preferences/consent/offer", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await offerPreferenceConsent(dbQuery, {
        customerId: req.user?.id,
        preferenceType: req.body?.preferenceType || req.body?.type,
        preferenceValue: req.body?.preferenceValue || req.body?.value || req.body,
        actor: "aura",
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "consent_offer_failed" });
    }
  });

  router.post("/preferences/consent/decline", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await declinePreferenceConsent(dbQuery, {
        customerId: req.user?.id,
        preferenceType: req.body?.preferenceType || null,
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "consent_decline_failed" });
    }
  });

  router.post("/preferences/consent/withdraw", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await withdrawConsent(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "consent_withdraw_failed" });
    }
  });

  router.get("/preferences/me", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await listCustomerPreferences(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "list_failed" });
    }
  });

  router.get("/preferences/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await getPreferenceForCustomer(dbQuery, {
        preferenceId: req.params.id,
        customerId: req.user?.id,
      });
      return res.status(out.ok ? 200 : out.error === "not_found_or_forbidden" ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "get_failed" });
    }
  });

  router.post("/preferences", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const consentGranted =
        req.body?.consentGranted === true ||
        req.body?.consent === true ||
        String(req.body?.consent || "").toLowerCase() === "yes";
      const out = await savePreferenceWithConsent(dbQuery, {
        customerId: req.user?.id,
        preferenceType: req.body?.preferenceType || req.body?.type,
        preferenceValue: req.body?.preferenceValue || req.body?.value || req.body,
        consentGranted,
        source: req.body?.source || "api",
        createdBy: "customer",
        actorUserId: req.user?.id,
      });
      const status = out.ok ? 200 : out.error === "consent_required" ? 403 : 400;
      return res.status(status).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "save_failed" });
    }
  });

  router.patch("/preferences/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const existing = await getPreferenceForCustomer(dbQuery, {
        preferenceId: req.params.id,
        customerId: req.user?.id,
      });
      if (!existing.ok) {
        return res.status(existing.error === "not_found_or_forbidden" ? 404 : 400).json(existing);
      }
      const consentGranted =
        req.body?.consentGranted === true ||
        req.body?.consent === true ||
        String(req.body?.consent || "").toLowerCase() === "yes";
      const out = await savePreferenceWithConsent(dbQuery, {
        customerId: req.user?.id,
        preferenceType: existing.preference.preferenceType,
        preferenceValue: req.body?.preferenceValue || req.body?.value || req.body,
        consentGranted,
        source: req.body?.source || "api",
        createdBy: "customer",
        actorUserId: req.user?.id,
      });
      return res.status(out.ok ? 200 : out.error === "consent_required" ? 403 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "update_failed" });
    }
  });

  router.delete("/preferences/me/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await deletePreference(dbQuery, {
        preferenceId: req.params.id,
        customerId: req.user?.id,
        actor: "customer",
        actorUserId: req.user?.id,
      });
      return res.status(out.ok ? 200 : out.error === "not_found_or_forbidden" ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "delete_failed" });
    }
  });

  router.delete("/preferences/me", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await deleteAllPreferences(dbQuery, { customerId: req.user?.id });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "delete_all_failed" });
    }
  });

  router.get("/preferences/suggestions", async (req, res) => {
    try {
      if (!auraPhase3Flags().preferenceSuggestions) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preference_suggestions_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await buildPreferenceSuggestions(dbQuery, {
        customerId: req.user?.id,
        force: req.query.force === "1",
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "suggestions_failed" });
    }
  });

  router.post("/preferences/suggestions/respond", async (req, res) => {
    try {
      if (!auraPhase3Flags().preferenceSuggestions) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preference_suggestions_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = await respondToPreferenceSuggestion(dbQuery, {
        customerId: req.user?.id,
        suggestionId: req.body?.suggestionId || req.body?.id || null,
        suggestionType: req.body?.suggestionType || req.body?.type || null,
        decision: req.body?.decision || req.body?.response,
        criteria: req.body?.criteria || null,
      });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "suggestion_respond_failed" });
    }
  });

  router.post("/preferences/assert-no-override", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAuth, req, res))) return;
      const out = assertPreferenceDoesNotOverride({
        slotAvailable: req.body?.slotAvailable === true,
      });
      return res.status(out.ok ? 200 : 409).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "assert_failed" });
    }
  });

  router.get("/admin/preferences", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      const customerId = req.query.customerId || req.query.customer_id;
      const out = await adminListPreferences(dbQuery, { customerId });
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "admin_list_failed" });
    }
  });

  router.delete("/admin/preferences/:id", async (req, res) => {
    try {
      if (!auraPhase3Flags().customerPreferences) {
        return res.status(404).json({ ok: false, error: "aura_phase3_preferences_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      const out = await deletePreference(dbQuery, {
        preferenceId: req.params.id,
        adminOverride: true,
        actor: "admin",
        actorUserId: req.user?.id || null,
      });
      return res.status(out.ok ? 200 : out.error === "not_found_or_forbidden" ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "admin_delete_failed" });
    }
  });

  router.post("/admin/preferences/migrate", async (req, res) => {
    try {
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      await ensureAuraPreferenceTables(dbQuery);
      return res.json({
        ok: true,
        migrated: ["aura_customer_preferences", "aura_customer_preference_events"],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "migrate_failed" });
    }
  });
}

module.exports = { attachAuraPreferenceRoutes };
