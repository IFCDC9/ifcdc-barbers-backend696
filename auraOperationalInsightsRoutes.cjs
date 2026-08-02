/**
 * Phase 3C Operational Insights routes — Super Admin only.
 * 404 unless operational insights (and dashboard for report endpoints) flags are on.
 * Read-only: no mutations of bookings/payments/schedules/preferences.
 */
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const {
  generateOperationalInsightsReport,
  previewInsightsDailyDigest,
} = require("./auraOperationalInsightsService.cjs");

function assertInsightsSuperAdmin(req, res) {
  const via = String(req.bookingsAdminScope?.via || "");
  if (via === "shop_owner" || (req.bookingsAdminScope && req.bookingsAdminScope.all !== true)) {
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

async function runMiddleware(fn, req, res) {
  if (typeof fn !== "function") return true;
  await new Promise((resolve, reject) => {
    fn(req, res, (err) => (err ? reject(err) : resolve()));
  });
  return !res.headersSent;
}

function attachAuraOperationalInsightsRoutes(router, { dbQuery, requireAdmin } = {}) {
  router.get("/insights/status", (_req, res) => {
    const flags = auraPhase3Flags();
    return res.json({
      ok: true,
      feature: "phase3c_operational_insights",
      operationalInsightsEnabled: Boolean(flags.operationalInsights),
      dashboardEnabled: Boolean(flags.insightsDashboard),
      dailyDigestEnabled: Boolean(flags.insightsDailyDigest),
      recommendationsEnabled: Boolean(flags.recommendations),
      readOnly: true,
      automaticOperationalAuthority: false,
      note: "Phase 3C defaults OFF. Reports never auto-change prices, schedules, bookings, payments, or outreach.",
    });
  });

  router.post("/admin/insights/report", async (req, res) => {
    try {
      const flags = auraPhase3Flags();
      if (!flags.operationalInsights) {
        return res.status(404).json({ ok: false, error: "aura_phase3_operational_insights_disabled" });
      }
      if (!flags.insightsDashboard) {
        return res.status(404).json({ ok: false, error: "aura_phase3_insights_dashboard_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      if (!assertInsightsSuperAdmin(req, res)) return;

      const out = await generateOperationalInsightsReport(dbQuery, {
        periodStart: req.body?.periodStart || req.body?.start || null,
        periodEnd: req.body?.periodEnd || req.body?.end || null,
        comparisonStart: req.body?.comparisonStart || null,
        comparisonEnd: req.body?.comparisonEnd || null,
        sections: req.body?.sections || null,
        actorUserId: req.user?.id || null,
        force: req.body?.force === true,
      });
      return res.status(out.ok ? 200 : out.error?.includes("disabled") ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "insights_failed" });
    }
  });

  router.post("/admin/insights/daily-digest/preview", async (req, res) => {
    try {
      const flags = auraPhase3Flags();
      if (!flags.operationalInsights) {
        return res.status(404).json({ ok: false, error: "aura_phase3_operational_insights_disabled" });
      }
      if (!(await runMiddleware(requireAdmin, req, res))) return;
      if (!assertInsightsSuperAdmin(req, res)) return;
      const out = await previewInsightsDailyDigest(dbQuery, {
        periodStart: req.body?.periodStart || null,
        periodEnd: req.body?.periodEnd || null,
        actorUserId: req.user?.id || null,
      });
      return res.status(out.ok ? 200 : 404).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "digest_failed" });
    }
  });
}

module.exports = {
  attachAuraOperationalInsightsRoutes,
  assertInsightsSuperAdmin,
};
