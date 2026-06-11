import crypto from "node:crypto";
import { createRequire } from "node:module";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import { normalizeEmail, sha256Hex } from "./authStore.js";
import { hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import { writeSecurityAudit } from "./auditSecurity.js";

const require = createRequire(import.meta.url);
const { buildPasswordResetUrl } = require("./publicSiteConfig.cjs");

async function resolveSuperAdminScope(req, res) {
  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ ok: false, success: false, message: "Missing Bearer token" });
    return null;
  }
  const payload = resolveAuthPayload(token);
  if (!payload) {
    res.status(401).json({ ok: false, success: false, message: "Invalid or expired token" });
    return null;
  }
  if (!isJwtGlobalSuperScope(payload)) {
    res.status(403).json({ ok: false, success: false, message: "Password recovery is restricted to super admins." });
    return null;
  }
  req.user = payload;
  return {
    actorId: String(payload.id || ""),
    actorEmail: String(payload.email || ""),
  };
}

async function loadAppUser(userId) {
  const r = await dbQuery(
    `SELECT id, name, email, role, account_status, force_password_change
     FROM app_users WHERE id = $1::uuid LIMIT 1`,
    [String(userId)],
  );
  return r.rows?.[0] || null;
}

function validateResetTarget(scope, target) {
  if (!target) return { ok: false, message: "User not found." };
  if (isSuperAdminEmail(target.email)) {
    return { ok: false, message: "The master IFCDC account cannot be reset from this console." };
  }
  if (scope.actorId && scope.actorId === String(target.id)) {
    return { ok: false, message: "You cannot reset your own active session account from here." };
  }
  const role = String(target.role || "").toLowerCase();
  if (role === "super_admin") {
    return { ok: false, message: "Super Admin accounts cannot be reset through this workflow." };
  }
  return { ok: true };
}

export function generateTempPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const nums = "23456789";
  const syms = "!@#$%&*-_+=";
  const pick = (chars, n) =>
    Array.from({ length: n }, () => chars[crypto.randomInt(0, chars.length)]).join("");
  const parts = [pick(upper, 2), pick(lower, 4), pick(nums, 3), pick(syms, 3)];
  const arr = parts.join("").split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

async function auditReset(req, scope, target, eventType, metadata = {}) {
  await writeSecurityAudit({
    eventType,
    actorUserId: scope.actorId,
    actorEmail: scope.actorEmail,
    req,
    metadata: {
      targetUserId: String(target.id),
      targetEmail: target.email,
      targetRole: target.role,
      userName: target.name,
      ...metadata,
    },
  });
}

function buildResetEmailHtml({ name, resetLink }) {
  return `
    <div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin:0 0 12px">IFCDC account recovery</h2>
      <p style="margin:0 0 12px">Hi ${name || "there"}, an administrator initiated a password reset for your IFCDC Barbers account.</p>
      <p style="margin:0 0 18px">
        <a href="${resetLink}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#d4af37;color:#0a0a0a;text-decoration:none;font-weight:700">
          Reset password
        </a>
      </p>
      <p style="margin:0;color:#666;font-size:12px">This link expires in 1 hour. If you did not expect this, contact IFCDC support.</p>
    </div>
  `;
}

/** Register admin password recovery routes on the admin router. */
export function registerAdminPasswordResetRoutes(router, { sendEmail } = {}) {
  router.post("/api/admin/send-password-reset", async (req, res) => {
    const scope = await resolveSuperAdminScope(req, res);
    if (!scope) return;

    try {
      const userId = String(req.body?.userId || req.body?.id || "").trim();
      if (!userId) return res.status(400).json({ ok: false, success: false, message: "userId is required." });

      const target = await loadAppUser(userId);
      const check = validateResetTarget(scope, target);
      if (!check.ok) return res.status(403).json({ ok: false, success: false, message: check.message });

      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await dbQuery(
        `UPDATE app_users
         SET reset_token_hash = $1, reset_token_expires_at = $2::timestamptz
         WHERE id = $3::uuid`,
        [tokenHash, expiresAt, userId],
      );

      const resetLink = buildPasswordResetUrl(rawToken);
      let emailSent = false;
      if (typeof sendEmail === "function") {
        try {
          const result = await sendEmail({
            to: target.email,
            subject: "IFCDC password reset requested",
            html: buildResetEmailHtml({ name: target.name, resetLink }),
            label: "admin-password-reset",
          });
          emailSent = Boolean(result?.success ?? result?.ok);
        } catch (e) {
          console.warn("[admin/password-reset] email failed:", e?.message || e);
        }
      }

      await auditReset(req, scope, target, "password_reset_request", {
        method: "send_email",
        emailSent,
      });

      return res.json({
        ok: true,
        success: true,
        message: emailSent ? "Password reset email sent" : "Password reset initiated",
        emailSent,
        userId,
      });
    } catch (e) {
      console.error("[admin/password-reset] send failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to send password reset" });
    }
  });

  router.post("/api/admin/reset-password", async (req, res) => {
    const scope = await resolveSuperAdminScope(req, res);
    if (!scope) return;

    try {
      const userId = String(req.body?.userId || req.body?.id || "").trim();
      if (!userId) return res.status(400).json({ ok: false, success: false, message: "userId is required." });

      const target = await loadAppUser(userId);
      const check = validateResetTarget(scope, target);
      if (!check.ok) return res.status(403).json({ ok: false, success: false, message: check.message });

      const generateTemporary = Boolean(req.body?.generateTemporary || req.body?.generateTemp);
      const disableUntilReset = Boolean(req.body?.disableUntilReset);
      const forcePasswordChange = Boolean(req.body?.forcePasswordChange);
      let temporaryPassword = String(req.body?.temporaryPassword || "").trim();

      if (generateTemporary || temporaryPassword) {
        if (!temporaryPassword) temporaryPassword = generateTempPassword();
        const pwCheck = validatePasswordStrength(temporaryPassword);
        if (!pwCheck.valid) {
          return res.status(400).json({ ok: false, success: false, message: pwCheck.message });
        }
        const passwordHash = await hashPassword(temporaryPassword);
        await dbQuery(
          `UPDATE app_users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL
           WHERE id = $2::uuid`,
          [passwordHash, userId],
        );
      }

      if (disableUntilReset) {
        await dbQuery(`UPDATE app_users SET account_status = 'disabled' WHERE id = $1::uuid`, [userId]);
      }

      if (forcePasswordChange) {
        await dbQuery(`UPDATE app_users SET force_password_change = true WHERE id = $1::uuid`, [userId]);
      }

      await auditReset(req, scope, target, "password_reset", {
        method: generateTemporary || temporaryPassword ? "temporary_password" : "recovery_flags",
        disableUntilReset,
        forcePasswordChange,
      });

      return res.json({
        ok: true,
        success: true,
        message: "Account recovery initiated",
        userId,
        temporaryPassword: temporaryPassword || null,
        disableUntilReset,
        forcePasswordChange,
      });
    } catch (e) {
      console.error("[admin/password-reset] reset failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to reset password" });
    }
  });

  router.put("/api/admin/force-password-change", async (req, res) => {
    const scope = await resolveSuperAdminScope(req, res);
    if (!scope) return;

    try {
      const userId = String(req.body?.userId || req.body?.id || "").trim();
      const force = req.body?.force !== false;
      if (!userId) return res.status(400).json({ ok: false, success: false, message: "userId is required." });

      const target = await loadAppUser(userId);
      const check = validateResetTarget(scope, target);
      if (!check.ok) return res.status(403).json({ ok: false, success: false, message: check.message });

      await dbQuery(`UPDATE app_users SET force_password_change = $1 WHERE id = $2::uuid`, [force, userId]);

      await auditReset(req, scope, target, "admin_change", {
        method: "force_password_change",
        force,
      });

      return res.json({
        ok: true,
        success: true,
        message: force ? "User must change password on next login" : "Forced password change cleared",
        userId,
        forcePasswordChange: force,
      });
    } catch (e) {
      console.error("[admin/password-reset] force-change failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to update password policy" });
    }
  });
}
