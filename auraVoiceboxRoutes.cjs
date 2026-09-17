/**
 * Voicebox audio (Twilio Play) + HQ/founder pronunciation corrections.
 * Audio GET is unauthenticated by design (Twilio must fetch it). IDs are UUIDs / random.
 */

const express = require("express");
const { getCachedAudio, getVoiceboxHqStatus, speak, probeHealth, takePendingRest, publicAudioUrl, runVoiceboxProdDiag } = require("./auraVoiceboxBridge.cjs");
const { getTurnTraces } = require("./auraVoiceCallRuntime.cjs");
const { upsertPronunciation, addLesson, getVoiceMemorySnapshot, listPronunciations } = require("./auraVoiceMemory.cjs");
const { isVoiceboxPrimary } = require("./auraVoiceboxFlags.cjs");
const { verifyVoiceboxTunnelRequest, voiceboxTunnelSecret } = require("./auraVoiceboxTunnelAuth.cjs");

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

  function requireDiagAuth(req, res) {
    const sa = trySuperAdmin(req);
    if (sa) return sa;
    const secret = voiceboxTunnelSecret();
    if (!secret) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return null;
    }
    const pathForSig = "/api/aura/voicebox/diag";
    const auth = verifyVoiceboxTunnelRequest({
      secret,
      method: req.method,
      path: pathForSig,
      body: req.body && Object.keys(req.body).length ? req.body : "",
      headers: req.headers,
    });
    if (auth.ok) return { diag: true, mode: auth.mode };
    res.status(401).json({ ok: false, error: "unauthorized" });
    return null;
  }

  function trySuperAdmin(req) {
    const token = extractBearer(req);
    if (!token || typeof resolveAuthPayload !== "function") return null;
    let user;
    try {
      user = resolveAuthPayload(token);
    } catch {
      return null;
    }
    const role = String(user?.role || "").toLowerCase();
    const email = String(user?.email || "");
    const sa = typeof isSuperAdminEmail === "function" ? isSuperAdminEmail(email) : false;
    if (!(role === "super_admin" || (user?.isSuperAdmin === true && sa))) return null;
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

  /** Twilio Redirect after first-phrase Play. Does not book. Polly fallback if rest fails. */
  router.all("/continue/:token", async (req, res) => {
    const token = String(req.params.token || "").trim();
    const pending = takePendingRest(token);
    const gather = String(req.query.gather || req.body?.gather || "").trim();
    const language = String(req.query.language || pending?.language || "en");
    const callSid = String(req.query.callSid || pending?.conversationId || "").trim();
    let rest = null;
    try {
      if (pending?.restPromise) {
        rest = await Promise.race([
          pending.restPromise,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("rest_timeout")), 12000);
          }),
        ]);
      }
    } catch (e) {
      console.warn("[aura/voicebox] continue rest fallback:", e?.message || e);
    }
    const playUrl = rest?.ok && rest.generationId ? publicAudioUrl(rest.generationId) : null;
    const say =
      language === "es"
        ? "Sigo aquí. Dime el día y la hora."
        : language === "he"
          ? "אני כאן. אפשר להמשיך עם ההזמנה."
          : "I'm here. Tell me the day and time that works.";
    const action = gather || "/api/aura/voice";
    let interrupted = false;
    try {
      const { snapshotLedger } = require("./auraVoiceCallRuntime.cjs");
      interrupted = Boolean(callSid && snapshotLedger(callSid).playbackInterrupted);
    } catch {
      interrupted = false;
    }
    const inner = interrupted
      ? `<Pause length="1"/>`
      : playUrl
        ? `<Play>${escapeXml(playUrl)}</Play>`
        : `<Say voice="Polly.Joanna" language="${language === "es" ? "es-ES" : "en-US"}">${escapeXml(say)}</Say>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="4" speechTimeout="auto" bargeIn="true" method="POST" action="${escapeXml(action)}">
    ${inner}
  </Gather>
  <Redirect method="POST">${escapeXml(action)}</Redirect>
</Response>`;
    res.type("text/xml");
    res.send(xml);
  });

  router.get("/turn-trace", (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const callSid = String(req.query.callSid || req.query.CALL_SESSION_ID || "").trim();
    const limit = Number(req.query.limit || 40);
    res.json({
      ok: true,
      callSid: callSid || null,
      traces: getTurnTraces(callSid, limit),
      note: "Safe fields only. No HMAC, phones, or secrets. Founder retest: dial +19895141064 from AURA_VOICEBOX_TEST_FROM.",
    });
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
        firstByteMs: result.firstByteMs ?? null,
        audioBytes: result.audio?.length || 0,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
    }
  });

  /**
   * Production tunnel check: HMAC health + Sample A generate through this backend.
   * Super Admin JWT or tunnel HMAC on path /api/aura/voicebox/diag. No public generate.
   */
  router.post("/diag", async (req, res) => {
    if (!requireDiagAuth(req, res)) return;
    try {
      const out = await runVoiceboxProdDiag({ text: req.body?.text });
      res.status(out.hmacReady || out.health.reachable ? 200 : 503).json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
    }
  });

  return router;
}

module.exports = { createAuraVoiceboxRouter };
