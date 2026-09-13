import express from "express";
import { requireAuth } from "./authRoutes.js";
import {
  ensurePhoneEnrollmentSchema,
  requestPhoneEnrollment,
  verifyPhoneEnrollment,
} from "./phoneEnrollmentService.js";

export function createPhoneEnrollmentRouter({ requireAuth: authMw } = {}) {
  const router = express.Router();
  const gate = typeof authMw === "function" ? authMw : requireAuth;

  router.post("/phone/request-verification", gate, async (req, res) => {
    try {
      await ensurePhoneEnrollmentSchema();
      const userId = String(req.user?.id || "").trim();
      const phone = req.body?.phone ?? req.body?.phoneNumber ?? req.body?.e164;
      const result = await requestPhoneEnrollment(userId, phone);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          ok: false,
          error: result.error,
          message: result.message,
          toMasked: result.toMasked || undefined,
        });
      }
      return res.json({
        ok: true,
        sent: result.sent !== false && !result.alreadyVerified,
        alreadyVerified: Boolean(result.alreadyVerified),
        toMasked: result.toMasked,
        expiresInSeconds: result.expiresInSeconds,
        message: result.message,
      });
    } catch (e) {
      console.error("[phone-enroll] request route failed", { error: String(e?.message || e).slice(0, 120) });
      return res.status(500).json({ ok: false, error: "server_error", message: "Could not send verification code." });
    }
  });

  router.post("/phone/verify", gate, async (req, res) => {
    try {
      await ensurePhoneEnrollmentSchema();
      const userId = String(req.user?.id || "").trim();
      const code = req.body?.code ?? req.body?.otp ?? req.body?.token;
      const result = await verifyPhoneEnrollment(userId, code);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          ok: false,
          error: result.error,
          message: result.message,
        });
      }
      return res.json({
        ok: true,
        phoneVerified: true,
        toMasked: result.toMasked,
        user: result.user,
        message: result.message,
      });
    } catch (e) {
      console.error("[phone-enroll] verify route failed", { error: String(e?.message || e).slice(0, 120) });
      return res.status(500).json({ ok: false, error: "server_error", message: "Could not verify code." });
    }
  });

  return router;
}
