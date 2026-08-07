/**
 * SMS HTTP routes — verify, consent, inbound keywords, admin delivery history.
 * Factory injects ESM deps from server.js (avoids CJS require of ESM modules).
 */
const express = require("express");
const { twilioConfigStatus } = require("./smsTwilioClient.cjs");
const { smsFlags } = require("./smsFlags.cjs");
const { ensureSmsSchema } = require("./smsMigrations.cjs");
const { startSmsVerification, checkSmsVerification } = require("./smsVerifyService.cjs");
const { upsertConsent, handleInboundSmsKeyword } = require("./smsConsentService.cjs");
const { updateLogBySid } = require("./smsDeliveryService.cjs");
const { maskPhoneForDisplay } = require("./smsPhone.cjs");
const {
  SMS_CONSENT_LANGUAGE_VERSION,
  SMS_CONSENT_DISCLOSURE,
  SMS_SENDER_IDENTITY,
} = require("./smsConsentPublic.cjs");

function createSmsRouter(deps = {}) {
  const {
    dbQuery,
    resolveAuthPayload,
    isSuperAdminEmail,
  } = deps;

  if (typeof dbQuery !== "function") {
    throw new Error("createSmsRouter requires dbQuery");
  }

  const router = express.Router();

  function extractBearer(req) {
    const h = String(req.get("authorization") || "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : "";
  }

  function requireUser(req, res) {
    const token = extractBearer(req);
    if (!token || typeof resolveAuthPayload !== "function") {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return null;
    }
    try {
      return resolveAuthPayload(token);
    } catch {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return null;
    }
  }

  function requireSuperAdmin(req, res) {
    const user = requireUser(req, res);
    if (!user) return null;
    const role = String(user.role || "").toLowerCase();
    const email = String(user.email || "");
    const sa =
      typeof isSuperAdminEmail === "function" ? isSuperAdminEmail(email) : false;
    if (!(role === "super_admin" || (user.isSuperAdmin === true && sa))) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return null;
    }
    return user;
  }

  router.get("/status", async (_req, res) => {
    let schemaReady = false;
    let schemaError = null;
    try {
      await ensureSmsSchema(dbQuery);
      schemaReady = true;
    } catch (e) {
      schemaError = String(e?.message || e).slice(0, 160);
    }
    return res.json({
      ok: true,
      flags: smsFlags(),
      schema: { ready: schemaReady, error: schemaError },
      callbacks: {
        statusUrl: "/api/sms/status",
        inboundUrl: "/api/sms/inbound",
        recommendedBase: "https://ifcdc-barbers-backend696.onrender.com",
      },
      twilio: twilioConfigStatus(),
    });
  });

  router.post("/verify/start", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const phone = String(req.body?.phone || "").trim();
    const purpose = String(req.body?.purpose || "customer_phone").slice(0, 40);
    const out = await startSmsVerification(dbQuery, {
      phone,
      purpose: purpose === "super_admin_login" ? "customer_phone" : purpose,
      actorUserId: user.id || user.sub,
      ipText: String(req.ip || "").slice(0, 80),
    });
    if (!out.ok) {
      const status =
        out.error === "rate_limited" || out.error === "retry_too_soon" ? 429 : 400;
      return res.status(status).json(out);
    }
    return res.json(out);
  });

  router.post("/verify/check", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const phone = String(req.body?.phone || "").trim();
    const code = String(req.body?.code || req.body?.verificationCode || "").trim();
    const out = await checkSmsVerification(dbQuery, {
      phone,
      code,
      purpose: "customer_phone",
      actorUserId: user.id || user.sub,
      ipText: String(req.ip || "").slice(0, 80),
      markUserVerified: true,
    });
    if (!out.ok) {
      const status = out.error === "rate_limited" ? 429 : 400;
      return res.status(status).json(out);
    }
    return res.json({ ok: true, phoneVerified: true, phoneE164: out.e164 });
  });

  router.post("/verify/super-admin/start", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || process.env.SUPER_ADMIN_SMS_PHONE || "").trim();
    if (typeof isSuperAdminEmail === "function" && !isSuperAdminEmail(email)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone_required",
        message: "Provide phone or set SUPER_ADMIN_SMS_PHONE.",
      });
    }
    const out = await startSmsVerification(dbQuery, {
      phone,
      purpose: "super_admin_login",
      ipText: String(req.ip || "").slice(0, 80),
    });
    if (!out.ok) {
      const status =
        out.error === "rate_limited" || out.error === "retry_too_soon" ? 429 : 400;
      return res.status(status).json(out);
    }
    return res.json(out);
  });

  router.post("/verify/super-admin/check", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || process.env.SUPER_ADMIN_SMS_PHONE || "").trim();
    const code = String(req.body?.code || req.body?.verificationCode || "").trim();
    if (typeof isSuperAdminEmail === "function" && !isSuperAdminEmail(email)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const out = await checkSmsVerification(dbQuery, {
      phone,
      code,
      purpose: "super_admin_login",
      ipText: String(req.ip || "").slice(0, 80),
      markUserVerified: false,
    });
    if (!out.ok) {
      const status = out.error === "rate_limited" ? 429 : 400;
      return res.status(status).json(out);
    }
    return res.json({ ok: true, verified: true, channel: "sms" });
  });

  router.get("/consent/disclosure", (_req, res) => {
    return res.json({
      ok: true,
      sender: SMS_SENDER_IDENTITY,
      languageVersion: SMS_CONSENT_LANGUAGE_VERSION,
      disclosure: SMS_CONSENT_DISCLOSURE,
      publicPages: {
        consent: "https://ifcdcbarbersapp.com/sms-consent",
        evidence: "https://ifcdcbarbersapp.com/sms-consent-evidence",
        terms: "https://ifcdcbarbersapp.com/terms",
        privacy: "https://ifcdcbarbersapp.com/privacy",
      },
    });
  });

  /** Public A2P opt-in — no auth. Does not create an account. */
  router.post("/consent/public", async (req, res) => {
    try {
      await ensureSmsSchema(dbQuery);
      const phone = String(req.body?.phone || "").trim();
      const optIn = req.body?.optIn === true || req.body?.opt_in === true;
      if (!optIn) {
        return res.status(400).json({
          ok: false,
          error: "opt_in_required",
          message: "Check the SMS consent box to opt in. SMS is optional for using the app.",
        });
      }
      const source = String(req.body?.source || "public_sms_consent_page").slice(0, 80);
      const consentLanguageVersion = String(
        req.body?.consentLanguageVersion || req.body?.consent_language_version || SMS_CONSENT_LANGUAGE_VERSION,
      ).slice(0, 80);
      const out = await upsertConsent(dbQuery, {
        phone,
        userId: null,
        optIn: true,
        source,
        consentLanguageVersion,
        metadata: {
          ip: String(req.ip || "").slice(0, 80) || null,
          userAgent: String(req.get("user-agent") || "").slice(0, 240) || null,
          path: "/api/sms/consent/public",
        },
      });
      if (!out.ok) return res.status(400).json(out);
      return res.json({
        ok: true,
        consent: {
          phoneMasked: maskPhoneForDisplay(out.consent?.phone_e164),
          transactionalOptIn: true,
          languageVersion: out.consent?.consent_language_version || consentLanguageVersion,
          optedInAt: out.consent?.opted_in_at || null,
          source: out.consent?.source || source,
        },
      });
    } catch (e) {
      console.warn("[sms] public consent error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "consent_failed" });
    }
  });

  router.post("/consent", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const phone = String(req.body?.phone || "").trim();
    const optIn = req.body?.optIn === true || req.body?.opt_in === true;
    const out = await upsertConsent(dbQuery, {
      phone,
      userId: user.id || user.sub,
      optIn,
      source: "user_api",
      consentLanguageVersion: String(
        req.body?.consentLanguageVersion || SMS_CONSENT_LANGUAGE_VERSION,
      ).slice(0, 80),
    });
    if (!out.ok) return res.status(400).json(out);
    // Keep notification prefs aligned with explicit consent
    try {
      if (user.id || user.sub) {
        await dbQuery(
          `INSERT INTO notification_preferences (user_id, sms_opt_in)
           VALUES ($1::uuid, $2)
           ON CONFLICT (user_id) DO UPDATE SET sms_opt_in = EXCLUDED.sms_opt_in`,
          [user.id || user.sub, Boolean(optIn)],
        ).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return res.json({
      ok: true,
      consent: {
        phoneMasked: maskPhoneForDisplay(out.consent?.phone_e164),
        transactionalOptIn: out.consent?.transactional_opt_in,
        languageVersion: out.consent?.consent_language_version || null,
      },
    });
  });

  router.post("/inbound", async (req, res) => {
    try {
      const from = String(req.body?.From || req.body?.from || "").trim();
      const body = String(req.body?.Body || req.body?.body || "").trim();
      const publicBase =
        process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || "";
      await handleInboundSmsKeyword(dbQuery, { from, body, publicBaseUrl: publicBase });
      res.type("text/xml").status(200).send("<Response></Response>");
    } catch (e) {
      console.warn("[sms] inbound error:", e?.message || e);
      res.type("text/xml").status(200).send("<Response></Response>");
    }
  });

  router.get("/admin/history", async (req, res) => {
    const admin = requireSuperAdmin(req, res);
    if (!admin) return;
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const category = String(req.query.category || "").trim();
    try {
      await ensureSmsSchema(dbQuery);
      const params = [];
      let where = "TRUE";
      if (category) {
        params.push(category);
        where = `category = $${params.length}`;
      }
      params.push(limit);
      const r = await dbQuery(
        `SELECT id, created_at, updated_at, twilio_sid, status, to_e164, category,
                booking_id, payment_ref, user_id, body_preview, error_code, error_message
         FROM sms_message_log
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      );
      const rows = (r.rows || []).map((row) => ({
        ...row,
        to_e164: row.to_e164 ? maskPhoneForDisplay(row.to_e164) : null,
      }));
      return res.json({ ok: true, count: rows.length, messages: rows });
    } catch (e) {
      console.warn("[sms] admin history failed:", e?.message || e);
      return res.status(500).json({ ok: false, error: "history_failed" });
    }
  });

  return router;
}

async function enrichSmsStatusCallback(dbQuery, body) {
  const raw = body && typeof body === "object" ? body : {};
  const messageSid = String(raw.MessageSid || raw.SmsSid || "").trim();
  const status = String(raw.MessageStatus || raw.SmsStatus || "").trim().toLowerCase();
  const errorCode = String(raw.ErrorCode ?? "").trim() || null;
  const errorMessage = String(raw.ErrorMessage ?? "").trim() || null;
  if (!messageSid || !status) return;
  await updateLogBySid(dbQuery, messageSid, {
    status,
    errorCode,
    errorMessage,
    providerPayload: {
      to: raw.To || null,
      from: raw.From || null,
      status,
      errorCode,
    },
  });
}

module.exports = {
  createSmsRouter,
  enrichSmsStatusCallback,
};
