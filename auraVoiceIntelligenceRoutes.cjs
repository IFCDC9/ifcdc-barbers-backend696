/**
 * Admin + status routes for AURA Voice Intelligence Phase 1.
 */
const express = require("express");
const {
  auraVoiceIntelligenceFlags,
  isAuraVoiceIntelligencePhase1,
  getOfficialAuraBusinessE164,
  getAuraOwnerAdminE164,
} = require("./auraVoiceIntelligenceFlags.cjs");
const { ensureAuraVoiceIntelligenceSchema } = require("./auraVoiceIntelligenceMigrations.cjs");
const { adminListCalls, adminCallStats } = require("./auraVoiceIntelligenceLog.cjs");
const { maskPhoneForDisplay } = require("./smsPhone.cjs");
const { getVoiceLatencyAverages } = require("./auraVoiceLatency.cjs");
const { getNoiseControlStats, getVoiceStackReport } = require("./auraVoiceNoiseControl.cjs");

function createAuraVoiceIntelligenceRouter(deps = {}) {
  const { dbQuery, resolveAuthPayload, isSuperAdminEmail } = deps;
  const router = express.Router();

  function extractBearer(req) {
    const h = String(req.get("authorization") || "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : "";
  }

  function requireSuperAdmin(req, res) {
    const token = extractBearer(req);
    if (!token || typeof resolveAuthPayload !== "function") {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return null;
    }
    let user;
    try {
      user = resolveAuthPayload(token);
    } catch {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return null;
    }
    const role = String(user?.role || "").toLowerCase();
    const email = String(user?.email || "");
    const sa = typeof isSuperAdminEmail === "function" ? isSuperAdminEmail(email) : false;
    if (!(role === "super_admin" || (user?.isSuperAdmin === true && sa))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return null;
    }
    return user;
  }

  router.get("/status", async (_req, res) => {
    let schemaReady = false;
    let schemaError = null;
    if (isAuraVoiceIntelligencePhase1() && typeof dbQuery === "function") {
      try {
        await ensureAuraVoiceIntelligenceSchema(dbQuery);
        schemaReady = true;
      } catch (e) {
        schemaError = String(e?.message || e).slice(0, 160);
      }
    }
    return res.json({
      ok: true,
      flags: auraVoiceIntelligenceFlags(),
      schema: { ready: schemaReady, error: schemaError },
      numbers: {
        officialBusinessMasked: maskPhoneForDisplay(getOfficialAuraBusinessE164()),
        ownerAdminMasked: maskPhoneForDisplay(getAuraOwnerAdminE164()),
        ownerPinConfigured: Boolean(String(process.env.AURA_OWNER_VOICE_PIN || "").trim()),
      },
      latency: getVoiceLatencyAverages(),
      noiseControl: getNoiseControlStats(),
      voiceStack: getVoiceStackReport(),
      note: "Phase 1 is off by default. Set AURA_VOICE_INTELLIGENCE_PHASE_1=true to enable.",
    });
  });

  router.get("/admin/calls", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!isAuraVoiceIntelligencePhase1()) {
      return res.status(404).json({ ok: false, error: "aura_voice_intelligence_disabled" });
    }
    try {
      const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
      const [calls, stats] = await Promise.all([
        adminListCalls(dbQuery, { limit }),
        adminCallStats(dbQuery),
      ]);
      return res.json({ ok: true, calls, stats });
    } catch (e) {
      console.warn("[aura-voice-intel] admin calls:", e?.message || e);
      return res.status(500).json({ ok: false, error: "list_failed" });
    }
  });

  router.get("/admin/escalations", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!isAuraVoiceIntelligencePhase1()) {
      return res.status(404).json({ ok: false, error: "aura_voice_intelligence_disabled" });
    }
    try {
      await ensureAuraVoiceIntelligenceSchema(dbQuery);
      const r = await dbQuery(
        `SELECT id, created_at, call_sid, from_e164, caller_name, reason, appointment_ref,
                recommended_next, status
         FROM aura_voice_escalations
         ORDER BY created_at DESC
         LIMIT 100`,
      );
      const rows = (r.rows || []).map((row) => ({
        ...row,
        from_e164: row.from_e164 ? maskPhoneForDisplay(row.from_e164) : null,
      }));
      return res.json({ ok: true, escalations: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "list_failed" });
    }
  });

  return router;
}

module.exports = {
  createAuraVoiceIntelligenceRouter,
};
