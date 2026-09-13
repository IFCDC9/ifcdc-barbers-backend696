import crypto from "node:crypto";
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";
import { normalizeEmail, sha256Hex } from "./authStore.js";
import { hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";

const require = createRequire(import.meta.url);
const { resolvePublicWebOrigin, buildPasswordResetUrl } = require("./publicSiteConfig.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SMS_OTP_TTL_MS = 10 * 60 * 1000;
const SMS_REQUEST_COOLDOWN_MS = 60 * 1000;
const SMS_MAX_VERIFY_ATTEMPTS = 5;
const SMS_LOCKOUT_MS = 15 * 60 * 1000;
const CANONICAL_SUPER_ADMIN_EMAIL = "service@ifcdc.org";
const OTP_HASH_PREFIX = "pwreset-sms";

/** Process-local request/verify throttle. Keyed by email — never stores codes or phones. */
const smsResetRateLimits = new Map();

export function resetSmsPasswordResetLimits() {
  smsResetRateLimits.clear();
}

function rateKey(email) {
  return normalizeEmail(email);
}

function getRateState(email) {
  const key = rateKey(email);
  if (!key) return null;
  const cur = smsResetRateLimits.get(key) || {
    lastRequestAt: 0,
    verifyAttempts: 0,
    lockedUntil: 0,
  };
  return { key, cur };
}

function queryFn(deps) {
  return typeof deps?.dbQuery === "function" ? deps.dbQuery : dbQuery;
}

function nowMs(deps) {
  if (typeof deps?.now === "function") return Number(deps.now()) || Date.now();
  if (Number.isFinite(deps?.now)) return Number(deps.now);
  return Date.now();
}

export function generateSmsResetCode(length = 6) {
  const n = Math.max(6, Math.min(8, Number(length) || 6));
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
}

export function hashSmsResetCode(userId, code) {
  return sha256Hex(`${OTP_HASH_PREFIX}:${String(userId)}:${String(code || "").trim()}`);
}

export function isSmsResetSessionToken(token) {
  return /^[a-f0-9]{64}$/i.test(String(token || "").trim());
}

/** Reads the same verified columns written by phone enrollment (`phone_e164` + `phone_verified`). */
export function resolveVerifiedResetPhone(user) {
  if (!user) return { ok: false, error: "no_user" };
  const verified = user.phone_verified === true || user.phone_verified === "t" || user.phone_verified === "true";
  if (!verified) return { ok: false, error: "phone_not_verified" };
  const raw = user.phone_e164 || user.phone || "";
  const n = normalizeToE164(raw);
  if (!n.ok) return { ok: false, error: "phone_invalid" };
  return { ok: true, e164: n.e164, masked: maskPhoneForDisplay(n.e164) };
}

function isDisabledAccount(user) {
  return String(user?.account_status || "").toLowerCase() === "disabled";
}

function isProtectedSuperAdmin(user, email) {
  const em = normalizeEmail(email || user?.email);
  const role = String(user?.role || "").toLowerCase();
  return em === CANONICAL_SUPER_ADMIN_EMAIL || role === "super_admin";
}

/** SPA origin for reset links — never the API host (see publicSiteConfig.cjs). */
export function resolvePublicWebUrl() {
  return resolvePublicWebOrigin();
}

export function isValidEmailFormat(email) {
  const em = normalizeEmail(email);
  return Boolean(em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em));
}

export async function loadAppUserByEmail(email, deps = {}) {
  const em = normalizeEmail(email);
  if (!em) return null;
  const q = queryFn(deps);
  const r = await q(
    `SELECT id, name, email, role, account_status
     FROM app_users
     WHERE lower(trim(email::text)) = $1
     LIMIT 1`,
    [em],
  );
  return r.rows?.[0] || null;
}

export async function loadAppUserForSmsReset(email, deps = {}) {
  const em = normalizeEmail(email);
  if (!em) return null;
  const q = queryFn(deps);
  const r = await q(
    `SELECT id, name, email, role, account_status, phone, phone_e164, phone_verified, apple_id,
            reset_token_hash, reset_token_expires_at
     FROM app_users
     WHERE lower(trim(email::text)) = $1
     LIMIT 1`,
    [em],
  );
  return r.rows?.[0] || null;
}

export async function getAppUserByResetTokenHash(tokenHash, deps = {}) {
  const hash = String(tokenHash || "").trim();
  if (!hash) return null;
  const q = queryFn(deps);
  const r = await q(
    `SELECT id, name, email, reset_token_expires_at, apple_id, role, account_status
     FROM app_users
     WHERE reset_token_hash = $1
     LIMIT 1`,
    [hash],
  );
  return r.rows?.[0] || null;
}

export async function setResetTokenForAppUserId(userId, { tokenHash, expiresAtIso }, deps = {}) {
  const q = queryFn(deps);
  await q(
    `UPDATE app_users
     SET reset_token_hash = $1, reset_token_expires_at = $2::timestamptz
     WHERE id = $3::uuid`,
    [tokenHash, expiresAtIso, String(userId)],
  );
}

export async function clearResetTokenForAppUserId(userId, deps = {}) {
  const q = queryFn(deps);
  await q(
    `UPDATE app_users
     SET reset_token_hash = NULL, reset_token_expires_at = NULL
     WHERE id = $1::uuid`,
    [String(userId)],
  );
}

/** Identity-safe: only password_hash + reset token columns. Never apple_id, role, assignments. */
export async function updatePasswordForAppUserId(userId, passwordHash, deps = {}) {
  const q = queryFn(deps);
  await q(
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
export const FORGOT_PASSWORD_USER_MESSAGES = {
  email_required: "Enter a valid email address.",
  email_unconfigured: "Password reset email is temporarily unavailable. Please try again later.",
  email_rate_limited: "Too many reset emails were requested. Please wait a few minutes and try again.",
  email_failed:
    "We could not deliver a reset email right now. Check spam, wait a few minutes, then try again. If this continues, contact support.",
  server_error: "Something went wrong starting the reset. Please try again.",
  sms_unconfigured: "Password reset is temporarily unavailable. Please try again later.",
  sms_rate_limited: "Too many reset requests. Please wait a few minutes and try again.",
  sms_failed: "We could not send a reset code right now. Please try again later.",
  invalid_code: "That code is invalid or expired. Try again.",
  code_required: "Enter the 6-digit code from your text message.",
  locked: "Too many incorrect codes. Please wait a few minutes and try again.",
};

export const NEUTRAL_SMS_FORGOT_MESSAGE =
  "If an account exists for that email and has a verified phone, a text with a reset code is on the way.";

export function classifyPasswordResetSendError(resultError) {
  const msg = String(resultError?.message || resultError || "").toLowerCase();
  if (/mail_from|resend_api_key|not configured|not set/.test(msg)) return "email_unconfigured";
  if (/429|rate limit|too many/.test(msg)) return "email_rate_limited";
  return "email_failed";
}

export function userFacingForgotPasswordMessage(errorCode) {
  return FORGOT_PASSWORD_USER_MESSAGES[errorCode] || FORGOT_PASSWORD_USER_MESSAGES.server_error;
}

export async function requestPasswordResetForEmail(email, { sendEmail, includeResetLink } = {}) {
  const em = normalizeEmail(email);
  if (!isValidEmailFormat(em)) {
    return { ok: false, error: "email_required", message: FORGOT_PASSWORD_USER_MESSAGES.email_required };
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
    return { ok: false, error: "email_unconfigured", message: "Password reset email is temporarily unavailable. Please try again later." };
  }

  const result = await sendEmail({
    to: em,
    subject: "Reset Your Password — IFCDC Barbers",
    html: buildCustomerResetEmailHtml({ name: user.name, resetLink }),
    label: "auth-reset-password",
  });

  if (result?.error) {
    const sendErr = result.error && typeof result.error === "object" ? result.error : { message: String(result.error) };
    const detail = String(sendErr.message || "").slice(0, 240);
    const classified = classifyPasswordResetSendError(sendErr);
    console.error("[password-reset] send failed", {
      error: classified,
      name: sendErr.name || null,
      statusCode: sendErr.statusCode ?? null,
      message: detail,
    });
    return {
      ok: false,
      error: classified,
      message: userFacingForgotPasswordMessage(classified),
    };
  }

  return {
    ok: true,
    sent: true,
    userFound: true,
    ...(includeResetLink === true ? { resetLink } : {}),
  };
}

export async function completePasswordResetWithToken(token, newPassword, deps = {}) {
  const rawToken = String(token || "").trim();
  const pw = String(newPassword || "");
  if (!rawToken) {
    return { ok: false, error: "token_required", message: "Reset token is required" };
  }
  if (!isSmsResetSessionToken(rawToken) && rawToken.length < 32) {
    return { ok: false, error: "invalid_token", message: "Invalid reset token" };
  }

  const resetPw = validatePasswordStrength(pw);
  if (!resetPw.valid) {
    return { ok: false, error: "weak_password", message: resetPw.message };
  }

  const tokenHash = sha256Hex(rawToken);
  const user = await getAppUserByResetTokenHash(tokenHash, deps);
  if (!user) {
    return { ok: false, error: "invalid_token", message: "Invalid reset token" };
  }
  if (isProtectedSuperAdmin(user, user.email)) {
    return { ok: false, error: "invalid_token", message: "Invalid reset token" };
  }

  const exp = user.reset_token_expires_at ? Date.parse(user.reset_token_expires_at) : 0;
  const now = nowMs(deps);
  if (!exp || Number.isNaN(exp) || now > exp) {
    await clearResetTokenForAppUserId(user.id, deps);
    return { ok: false, error: "token_expired", message: "Reset token expired" };
  }

  const passwordHash = await hashPassword(pw);
  await updatePasswordForAppUserId(user.id, passwordHash, deps);
  const st = getRateState(user.email);
  if (st) smsResetRateLimits.delete(st.key);
  return { ok: true, userId: user.id, email: user.email, appleIdPreserved: user.apple_id != null };
}

async function defaultSendResetSms({ to, body, userId, idempotencyKey }) {
  const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
  return sendTransactionalSms(dbQuery, {
    to,
    body,
    category: "security_verify",
    userId,
    force: true,
    idempotencyKey,
  });
}

/**
 * SMS-first forgot password. Never reveals whether the email exists.
 * Sends only to a verified phone already on THIS app_users row.
 */
export async function requestSmsPasswordReset(email, deps = {}) {
  const em = normalizeEmail(email);
  if (!isValidEmailFormat(em)) {
    return { ok: false, error: "email_required", message: FORGOT_PASSWORD_USER_MESSAGES.email_required };
  }

  const now = nowMs(deps);
  const st = getRateState(em);
  if (st && st.cur.lockedUntil > now) {
    return { ok: false, error: "sms_rate_limited", message: FORGOT_PASSWORD_USER_MESSAGES.sms_rate_limited };
  }
  if (st && st.cur.lastRequestAt && now - st.cur.lastRequestAt < SMS_REQUEST_COOLDOWN_MS) {
    return { ok: false, error: "sms_rate_limited", message: FORGOT_PASSWORD_USER_MESSAGES.sms_rate_limited };
  }
  if (st) {
    st.cur.lastRequestAt = now;
    smsResetRateLimits.set(st.key, st.cur);
  }

  const user = await loadAppUserForSmsReset(em, deps);
  const generic = {
    ok: true,
    sent: false,
    userFound: Boolean(user),
    message: NEUTRAL_SMS_FORGOT_MESSAGE,
  };

  if (!user || isDisabledAccount(user) || isProtectedSuperAdmin(user, em)) {
    return generic;
  }

  const phone = resolveVerifiedResetPhone(user);
  if (!phone.ok) {
    return { ...generic, reason: phone.error };
  }

  const generate = typeof deps.generateCode === "function" ? deps.generateCode : generateSmsResetCode;
  const code = String(generate()).replace(/\D/g, "");
  if (!/^\d{6,8}$/.test(code)) {
    return { ok: false, error: "server_error", message: FORGOT_PASSWORD_USER_MESSAGES.server_error };
  }

  const tokenHash = hashSmsResetCode(user.id, code);
  const expiresAtIso = new Date(now + SMS_OTP_TTL_MS).toISOString();
  await setResetTokenForAppUserId(user.id, { tokenHash, expiresAtIso }, deps);

  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : defaultSendResetSms;
  try {
    const sent = await sendSms({
      to: phone.e164,
      body: `IFCDC password reset code: ${code}. Expires in 10 minutes. Do not share this code.`,
      userId: user.id,
      idempotencyKey: `pwreset-sms-${user.id}-${expiresAtIso}`,
    });
    const delivered =
      Boolean(sent?.ok) &&
      (!sent?.skipped || sent?.reason === "idempotent_duplicate" || sent?.duplicate === true);
    if (!delivered) {
      console.error("[password-reset] sms send failed", {
        error: sent?.reason || sent?.error || "sms_failed",
        toMasked: phone.masked,
      });
    }
    return {
      ok: true,
      sent: Boolean(delivered),
      userFound: true,
      toMasked: phone.masked,
      message: NEUTRAL_SMS_FORGOT_MESSAGE,
    };
  } catch (e) {
    console.error("[password-reset] sms send exception", {
      error: String(e?.message || e).slice(0, 120),
      toMasked: phone.masked,
    });
    return { ok: true, sent: false, userFound: true, message: NEUTRAL_SMS_FORGOT_MESSAGE };
  }
}

export async function verifySmsPasswordResetCode(email, code, deps = {}) {
  const em = normalizeEmail(email);
  const raw = String(code || "").trim().replace(/\s+/g, "");
  if (!isValidEmailFormat(em)) {
    return { ok: false, error: "email_required", message: FORGOT_PASSWORD_USER_MESSAGES.email_required };
  }
  if (!/^\d{6,8}$/.test(raw)) {
    return { ok: false, error: "code_required", message: FORGOT_PASSWORD_USER_MESSAGES.code_required };
  }

  const now = nowMs(deps);
  const st = getRateState(em);
  if (st && st.cur.lockedUntil > now) {
    return { ok: false, error: "locked", message: FORGOT_PASSWORD_USER_MESSAGES.locked };
  }

  const bumpFailure = () => {
    if (!st) return;
    st.cur.verifyAttempts = Number(st.cur.verifyAttempts || 0) + 1;
    if (st.cur.verifyAttempts >= SMS_MAX_VERIFY_ATTEMPTS) {
      st.cur.lockedUntil = now + SMS_LOCKOUT_MS;
    }
    smsResetRateLimits.set(st.key, st.cur);
  };

  const user = await loadAppUserForSmsReset(em, deps);
  if (!user || isDisabledAccount(user) || isProtectedSuperAdmin(user, em)) {
    bumpFailure();
    return { ok: false, error: "invalid_code", message: FORGOT_PASSWORD_USER_MESSAGES.invalid_code };
  }

  const expected = hashSmsResetCode(user.id, raw);
  const stored = String(user.reset_token_hash || "");
  if (!stored || stored !== expected) {
    bumpFailure();
    const locked = st && st.cur.verifyAttempts >= SMS_MAX_VERIFY_ATTEMPTS;
    return {
      ok: false,
      error: locked ? "locked" : "invalid_code",
      message: locked ? FORGOT_PASSWORD_USER_MESSAGES.locked : FORGOT_PASSWORD_USER_MESSAGES.invalid_code,
    };
  }

  const exp = user.reset_token_expires_at ? Date.parse(user.reset_token_expires_at) : 0;
  if (!exp || Number.isNaN(exp) || now > exp) {
    await clearResetTokenForAppUserId(user.id, deps);
    bumpFailure();
    return { ok: false, error: "invalid_code", message: FORGOT_PASSWORD_USER_MESSAGES.invalid_code };
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const sessionHash = sha256Hex(rawToken);
  const sessionExp = new Date(now + RESET_TOKEN_TTL_MS).toISOString();
  await setResetTokenForAppUserId(user.id, { tokenHash: sessionHash, expiresAtIso: sessionExp }, deps);
  if (st) {
    st.cur.verifyAttempts = 0;
    st.cur.lockedUntil = 0;
    smsResetRateLimits.set(st.key, st.cur);
  }
  return {
    ok: true,
    resetToken: rawToken,
    userId: user.id,
    toMasked: resolveVerifiedResetPhone(user).ok ? resolveVerifiedResetPhone(user).masked : null,
  };
}
