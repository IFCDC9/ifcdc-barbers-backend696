/**
 * AURA Phase 2 ops routes — mounted only when AURA_PHASE2_ENABLED=1.
 * Daily report defaults to dry-run; send requires AURA_DAILY_REPORT_ENABLED + force.
 */
const express = require("express");
const { auraPhase2Flags, isAuraPhase2Enabled, auraReceptionistIdentity } = require("./auraPhase2Flags.cjs");
const { generateAuraDailyReport } = require("./auraDailyReport.cjs");
const { dispatchAuraTool, denySensitive } = require("./auraPhase2Tools.cjs");
const { ensureAuraActionLogTable, ensureAuraReminderColumns } = require("./auraActionLog.cjs");

function createAuraPhase2Router({ dbQuery, requireAdmin } = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isAuraPhase2Enabled()) {
      return res.status(404).json({ ok: false, error: "aura_phase2_disabled" });
    }
    return next();
  });

  router.get("/status", (req, res) => {
    const flags = auraPhase2Flags();
    return res.json({
      ok: true,
      identity: auraReceptionistIdentity(),
      flags,
      mailFromUnchanged: true,
      preferredFutureSender: "AURA <aura@aura.ifcdcbarbersapp.com>",
      note: "MAIL_FROM is not switched by Phase 2. Enable flags only after E2E approval.",
    });
  });

  router.get("/daily-report", async (req, res) => {
    try {
      if (typeof requireAdmin === "function") {
        await new Promise((resolve, reject) => {
          requireAdmin(req, res, (err) => (err ? reject(err) : resolve()));
        });
        if (res.headersSent) return;
      }
      const dayYmd = String(req.query.day || "").trim() || null;
      const forceSend = String(req.query.send || "") === "1";
      const out = await generateAuraDailyReport(dbQuery, {
        dayYmd,
        dryRun: !forceSend,
        forceSend,
      });
      return res.json(out);
    } catch (e) {
      console.error("[aura-phase2] daily-report:", e?.message || e);
      return res.status(500).json({ ok: false, error: e?.message || "report_failed" });
    }
  });

  router.post("/tools/:toolName", async (req, res) => {
    try {
      if (typeof requireAdmin === "function") {
        await new Promise((resolve, reject) => {
          requireAdmin(req, res, (err) => (err ? reject(err) : resolve()));
        });
        if (res.headersSent) return;
      }
      const toolName = String(req.params.toolName || "").trim();
      const denied = denySensitive(toolName);
      if (denied) return res.status(403).json(denied);
      const out = await dispatchAuraTool(dbQuery, toolName, req.body || {});
      return res.status(out.ok ? 200 : 400).json(out);
    } catch (e) {
      console.error("[aura-phase2] tools:", e?.message || e);
      return res.status(500).json({ ok: false, error: e?.message || "tool_failed" });
    }
  });

  router.post("/reminders/scan", async (req, res) => {
    try {
      if (typeof requireAdmin === "function") {
        await new Promise((resolve, reject) => {
          requireAdmin(req, res, (err) => (err ? reject(err) : resolve()));
        });
        if (res.headersSent) return;
      }
      const dryRun = req.body?.dryRun !== false && String(req.query.dryRun || "1") !== "0";
      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          message: "Dry-run only — set dryRun=0 to execute enabled reminder scanners.",
          flags: auraPhase2Flags(),
        });
      }
      const { scanAllEnabledBookingReminders } = await import("./bookingReminders.js");
      const out = await scanAllEnabledBookingReminders();
      return res.json({ ok: true, dryRun: false, results: out });
    } catch (e) {
      console.error("[aura-phase2] reminders:", e?.message || e);
      return res.status(500).json({ ok: false, error: e?.message || "reminder_scan_failed" });
    }
  });

  router.post("/migrate", async (req, res) => {
    try {
      if (typeof requireAdmin === "function") {
        await new Promise((resolve, reject) => {
          requireAdmin(req, res, (err) => (err ? reject(err) : resolve()));
        });
        if (res.headersSent) return;
      }
      await ensureAuraActionLogTable(dbQuery);
      await ensureAuraReminderColumns(dbQuery);
      return res.json({ ok: true, migrated: ["aura_action_logs", "reminder_*_sent_at"] });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "migrate_failed" });
    }
  });

  return router;
}

module.exports = { createAuraPhase2Router };
