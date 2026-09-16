/**
 * Voicebox audio (Twilio Play) + HQ/founder pronunciation corrections.
 * Audio GET is unauthenticated by design (Twilio must fetch it). IDs are UUIDs / random.
 */

const express = require("express");
const { getCachedAudio, getVoiceboxHqStatus, speak, probeHealth } = require("./auraVoiceboxBridge.cjs");
const { upsertPronunciation, addLesson, getVoiceMemorySnapshot, listPronunciations } = require("./auraVoiceMemory.cjs");
const { isVoiceboxPrimary } = require("./auraVoiceboxFlags.cjs");

function createAuraVoiceboxRouter(deps = {}) {
  const { resolveAuthPayload, isSuperAdminEmail } = deps;
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

  router.get("/audio/:id", (req, res) => {
    const id = String(req.params.id || "").trim();
    const hit = getCachedAudio(id);
    if (!hit) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    res.set("Content-Type", hit.contentType || "audio/wav");
    res.set("Cache-Control", "no-store");
    res.send(hit.buffer);
  });

  router.get("/status", async (_req, res) => {
    try {
      const status = await getVoiceboxHqStatus();
      res.json({ ok: true, voicebox: status, primary: isVoiceboxPrimary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
    }
  });

  router.get("/health", async (_req, res) => {
    const health = await probeHealth(true);
    res.status(health.reachable ? 200 : 503).json({ ok: health.reachable, ...health });
  });

  router.get("/memory", (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    res.json({ ok: true, memory: getVoiceMemorySnapshot(), pronunciations: listPronunciations() });
  });

  router.post("/memory/pronunciation", (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    try {
      const row = upsertPronunciation({
        id: req.body?.id,
        from: req.body?.from || req.body?.term,
        to: req.body?.to || req.body?.speak,
        note: req.body?.note,
      });
      res.json({ ok: true, pronunciation: row });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.post("/memory/lesson", (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    try {
      const lesson = addLesson(req.body?.text || req.body?.lesson, { source: "founder" });
      res.json({ ok: true, lesson });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /** HQ preview — never used for booking. */
  router.post("/preview", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    try {
      const result = await speak({
        text: req.body?.text || "Hi, this is Aura.",
        language: req.body?.language || "en",
        emotionalTone: req.body?.emotionalTone,
        speed: req.body?.speed,
        conversationId: "hq-preview",
      });
      res.json({
        ok: result.ok,
        fallback: result.fallback || false,
        generationId: result.generationId || null,
        reason: result.reason || null,
        language: result.language || req.body?.language || "en",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
    }
  });

  return router;
}

module.exports = { createAuraVoiceboxRouter };
