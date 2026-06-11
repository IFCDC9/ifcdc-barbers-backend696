import crypto from "node:crypto";
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";
import { normalizeEmail, sha256Hex } from "./authStore.js";
import { hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";

const require = createRequire(import.meta.url);
const { resolvePublicWebOrigin, buildPasswordResetUrl } = require("./publicSiteConfig.cjs");

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** SPA origin for reset links — never the API host (see publicSiteConfig.cjs). */
export function resolvePublicWebUrl() {
  return resolvePublicWebOrigin();
}

export function isValidEmailFormat(email) {
  const em = normalizeEmail(email);
  return Boolean(em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em));
}

export async function loadAppUserByEmail(email) {
  const em = normalizeEmail(email);
  if (!em) return null;
  const r = await dbQuery(
    `SELECT id, name, email, role, account_status
     FROM app_users
     WHERE lower(trim(email::text)) = $1
     LIMIT 1`,
    [em],
  );
  return r.rows?.[0] || null;
}

export async function getAppUserByResetTokenHash(tokenHash) {
  const hash = String(tokenHash || "").trim();
  if (!hash) return null;
  const r = await dbQuery(
    `SELECT id, name, email, reset_token_expires_at
     FROM app_users
     WHERE reset_token_hash = $1
     LIMIT 1`,
    [hash],
  );
  return r.rows?.[0] || null;
}

export async function setResetTokenForAppUserId(userId, { tokenHash, expiresAtIso }) {
  await dbQuery(
    `UPDATE app_users
     SET reset_token_hash = $1, reset_token_expires_at = $2::timestamptz
     WHERE id = $3::uuid`,
    [tokenHash, expiresAtIso, String(userId)],
  );
}

export async function clearResetTokenForAppUserId(userId) {
  await dbQuery(
    `UPDATE app_users
     SET reset_token_hash = NULL, reset_token_expires_at = NULL
     WHERE id = $1::uuid`,
    [String(userId)],
  );
}

export async function updatePasswordForAppUserId(userId, passwordHash) {
  await dbQuery(
    `UPDATE app_users
     SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL
     WHERE id = $2::uuid`,
    [passwordHash, String(userId)],
  );
}

export function buildCustomerResetEmailHtml({ name, resetLink }) {
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin:0 0 12px">Reset Your Password</h2>
      <p style="margin:0 0 12px">Hi ${name || "there"}, we received a request to reset your IFCDC Barbers password.</p>
      <p style="margin:0 0 18px">
        <a href="${resetLink}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#d4af37;color:#0a0a0a;text-decoration:none;font-weight:700">
          Reset password
        </a>
      </p>
      <p style="margin:0 0 12px;color:#444">This link expires in 1 hour.</p>
      <p style="margin:0;color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>
    </div>
  `;
}

/**
 * Issue reset token + send email via Resend (not Supabase Auth).
 * Returns neutral result — caller should not leak whether email exists.
 */
export async function requestPasswordResetForEmail(email, { sendEmail } = {}) {
  const em = normalizeEmail(email);
  if (!isValidEmailFormat(em)) {
    return { ok: false, error: "email_required", message: "Email is required" };
  }

  const user = await loadAppUserByEmail(em);
  if (!user) {
    return { ok: true, sent: false, userFound: false };
  }

  if (String(user.account_status || "").toLowerCase() === "disabled") {
    return { ok: true, sent: false, userFound: true, disabled: true };
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const expiresAtIso = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await setResetTokenForAppUserId(user.id, { tokenHash, expiresAtIso });

  const resetLink = buildPasswordResetUrl(rawToken);

  if (typeof sendEmail !== "function") {
    return { ok: false, error: "email_unconfigured", message: "Email service is not configured" };
  }

  const result = await sendEmail({
    to: em,
    subject: "Reset Your Password — IFCDC Barbers",
    html: buildCustomerResetEmailHtml({ name: user.name, resetLink }),
    label: "auth-reset-password",
  });

  if (result?.error) {
    console.error("[password-reset] resend error:", result.error);
    return { ok: false, error: "email_failed", message: "Could not send reset email" };
  }

  return { ok: true, sent: true, userFound: true, resetLink };
}

export async function completePasswordResetWithToken(token, newPassword) {
  const rawToken = String(token || "").trim();
  const pw = String(newPassword || "");
  if (!rawToken) {
    return { ok: false, error: "token_required", message: "Reset token is required" };
  }

  const resetPw = validatePasswordStrength(pw);
  if (!resetPw.valid) {
    return { ok: false, error: "weak_password", message: resetPw.message };
  }

  const tokenHash = sha256Hex(rawToken);
  const user = await getAppUserByResetTokenHash(tokenHash);
  if (!user) {
    return { ok: false, error: "invalid_token", message: "Invalid reset token" };
  }

  const exp = user.reset_token_expires_at ? Date.parse(user.reset_token_expires_at) : 0;
  if (!exp || Number.isNaN(exp) || Date.now() > exp) {
    await clearResetTokenForAppUserId(user.id);
    return { ok: false, error: "token_expired", message: "Reset token expired" };
  }

  const passwordHash = await hashPassword(pw);
  await updatePasswordForAppUserId(user.id, passwordHash);
  return { ok: true, userId: user.id, email: user.email };
}
