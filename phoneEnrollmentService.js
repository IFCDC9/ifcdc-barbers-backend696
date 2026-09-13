import crypto from "node:crypto";
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";
import { sha256Hex } from "./authStore.js";
import { CANONICAL_SUPER_ADMIN_EMAIL, isSuperAdminEmail } from "./rolePolicy.js";
import { publicUserFromAppUser } from "./authPlatformJwt.js";

const require = createRequire(import.meta.url);
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");

const OTP_TTL_MS = 10 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const OTP_HASH_PREFIX = "phone-enroll";
const CANONICAL_SUPER_ADMIN_SMS_E164 = "+18484694448";

/** Process-local throttle + consumed-OTP memory. Never stores plaintext codes. */
const enrollLimits = new Map();

export function resetPhoneEnrollmentLimits() {
  enrollLimits.clear();
}

export const PHONE_ENROLL_MESSAGES = {
  unauthorized: "Sign in to add a phone number.",
  phone_required: "Enter a valid mobile number.",
  phone_invalid: "Enter a valid phone number, including country code.",
  phone_reserved: "That number cannot be used for this account.",
  rate_limited: "Too many requests. Please wait a few minutes and try again.",
  locked: "Too many incorrect codes. Please wait a few minutes and try again.",
  sms_failed: "We could not send a verification code right now. Please try again later.",
  code_required: "Enter the 6-digit code from your text message.",
  invalid_code: "That code is invalid or expired. Try again.",
  expired: "That code expired. Request a new one.",
  reused: "That code was already used. Request a new one.",
  duplicate_phone: "That phone number is already verified on another account.",
  already_verified: "This phone number is already verified on your account.",
  server_error: "Something went wrong. Please try again.",
};

function queryFn(deps) {
  return typeof deps?.dbQuery === "function" ? deps.dbQuery : dbQuery;
}

function nowMs(deps) {
  if (typeof deps?.now === "function") return Number(deps.now()) || Date.now();
  if (Number.isFinite(deps?.now)) return Number(deps.now);
  return Date.now();
}

function rateKey(userId) {
  return String(userId || "").trim();
}

function getRateState(userId) {
  const key = rateKey(userId);
  if (!key) return null;
  const cur = enrollLimits.get(key) || {
    lastRequestAt: 0,
    windowStart: 0,
    requestCount: 0,
    verifyAttempts: 0,
    lockedUntil: 0,
    consumedHash: null,
  };
  return { key, cur };
}

export function generateEnrollmentCode(length = 6) {
  const n = Math.max(6, Math.min(8, Number(length) || 6));
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
}

export function hashEnrollmentCode(userId, code) {
  return sha256Hex(`${OTP_HASH_PREFIX}:${String(userId)}:${String(code || "").trim()}`);
}

export function isPhoneVerifiedFlag(value) {
  return value === true || value === "t" || value === "true";
}

export async function ensurePhoneEnrollmentSchema(dbQueryFn) {
  const q = typeof dbQueryFn === "function" ? dbQueryFn : dbQuery;
  const { ensureAppUserPhoneVerificationColumns } = require("./smsMigrations.cjs");
  await ensureAppUserPhoneVerificationColumns(q);
  await q(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_enroll_otp_hash TEXT`);
  await q(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_enroll_otp_expires_at TIMESTAMPTZ`);
  await q(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_enroll_phone_e164 TEXT`);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_verified_phone_e164_uidx
    ON app_users (phone_e164)
    WHERE phone_verified IS TRUE
      AND phone_e164 IS NOT NULL
      AND btrim(phone_e164) <> ''
  `);
}

async function loadAppUserForEnrollment(userId, deps = {}) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const q = queryFn(deps);
  const r = await q(
    `SELECT id, name, email, role, account_status, phone, phone_e164, phone_verified, phone_verified_at,
            apple_id, phone_enroll_otp_hash, phone_enroll_otp_expires_at, phone_enroll_phone_e164
     FROM app_users
     WHERE id = $1::uuid
     LIMIT 1`,
    [id],
  );
  return r.rows?.[0] || null;
}

async function findOtherVerifiedPhoneOwner(e164, userId, deps = {}) {
  const q = queryFn(deps);
  const r = await q(
    `SELECT id
     FROM app_users
     WHERE phone_verified IS TRUE
       AND phone_e164 = $1
       AND id <> $2::uuid
     LIMIT 1`,
    [e164, String(userId)],
  );
  return r.rows?.[0] || null;
}

function isDisabledAccount(user) {
  return String(user?.account_status || "").toLowerCase() === "disabled";
}

function normalizeEnrollmentPhone(raw) {
  return normalizeToE164(raw);
}

function reservedForSuperAdmin(e164, user) {
  if (e164 !== CANONICAL_SUPER_ADMIN_SMS_E164) return false;
  return !isSuperAdminEmail(user?.email);
}

async function defaultSendEnrollmentSms({ to, body, userId, idempotencyKey }) {
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

function bumpRequestWindow(st, now) {
  if (!st.cur.windowStart || now - st.cur.windowStart >= REQUEST_WINDOW_MS) {
    st.cur.windowStart = now;
    st.cur.requestCount = 0;
  }
  st.cur.requestCount += 1;
  st.cur.lastRequestAt = now;
  enrollLimits.set(st.key, st.cur);
}

/**
 * Start verified-phone enrollment for an existing JWT app_users row.
 * Does not mark verified. Does not change apple_id, role, or assignments.
 */
export async function requestPhoneEnrollment(userId, phoneRaw, deps = {}) {
  const id = String(userId || "").trim();
  if (!id) {
    return { ok: false, status: 401, error: "unauthorized", message: PHONE_ENROLL_MESSAGES.unauthorized };
  }

  const parsed = normalizeEnrollmentPhone(phoneRaw);
  if (!parsed.ok) {
    const err = parsed.error === "phone_required" ? "phone_required" : "phone_invalid";
    return { ok: false, status: 400, error: err, message: parsed.message || PHONE_ENROLL_MESSAGES[err] };
  }

  const now = nowMs(deps);
  const st = getRateState(id);
  if (st && st.cur.lockedUntil > now) {
    return { ok: false, status: 429, error: "rate_limited", message: PHONE_ENROLL_MESSAGES.rate_limited };
  }
  if (st && st.cur.lastRequestAt && now - st.cur.lastRequestAt < REQUEST_COOLDOWN_MS) {
    return { ok: false, status: 429, error: "rate_limited", message: PHONE_ENROLL_MESSAGES.rate_limited };
  }
  if (st) {
    if (!st.cur.windowStart || now - st.cur.windowStart >= REQUEST_WINDOW_MS) {
      st.cur.windowStart = now;
      st.cur.requestCount = 0;
    }
    if (st.cur.requestCount >= MAX_REQUESTS_PER_WINDOW) {
      return { ok: false, status: 429, error: "rate_limited", message: PHONE_ENROLL_MESSAGES.rate_limited };
    }
  }

  const user = await loadAppUserForEnrollment(id, deps);
  if (!user || isDisabledAccount(user)) {
    return { ok: false, status: 401, error: "unauthorized", message: PHONE_ENROLL_MESSAGES.unauthorized };
  }

  if (reservedForSuperAdmin(parsed.e164, user)) {
    return { ok: false, status: 400, error: "phone_reserved", message: PHONE_ENROLL_MESSAGES.phone_reserved };
  }

  if (isPhoneVerifiedFlag(user.phone_verified) && String(user.phone_e164 || "") === parsed.e164) {
    return {
      ok: true,
      alreadyVerified: true,
      toMasked: maskPhoneForDisplay(parsed.e164),
      message: PHONE_ENROLL_MESSAGES.already_verified,
    };
  }

  const other = await findOtherVerifiedPhoneOwner(parsed.e164, user.id, deps);
  if (other) {
    return { ok: false, status: 409, error: "duplicate_phone", message: PHONE_ENROLL_MESSAGES.duplicate_phone };
  }

  const generate = typeof deps.generateCode === "function" ? deps.generateCode : generateEnrollmentCode;
  const code = String(generate()).replace(/\D/g, "");
  if (!/^\d{6,8}$/.test(code)) {
    return { ok: false, status: 500, error: "server_error", message: PHONE_ENROLL_MESSAGES.server_error };
  }

  const tokenHash = hashEnrollmentCode(user.id, code);
  const expiresAtIso = new Date(now + OTP_TTL_MS).toISOString();
  const q = queryFn(deps);
  await q(
    `UPDATE app_users
     SET phone_enroll_otp_hash = $1,
         phone_enroll_otp_expires_at = $2::timestamptz,
         phone_enroll_phone_e164 = $3
     WHERE id = $4::uuid`,
    [tokenHash, expiresAtIso, parsed.e164, user.id],
  );

  if (st) {
    bumpRequestWindow(st, now);
    st.cur.consumedHash = null;
    enrollLimits.set(st.key, st.cur);
  }

  const toMasked = maskPhoneForDisplay(parsed.e164);
  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : defaultSendEnrollmentSms;
  try {
    const sent = await sendSms({
      to: parsed.e164,
      body: `IFCDC verification code: ${code}. Expires in 10 minutes. Do not share this code.`,
      userId: user.id,
      idempotencyKey: `phone-enroll-${user.id}-${expiresAtIso}`,
    });
    const delivered =
      Boolean(sent?.ok) &&
      (!sent?.skipped || sent?.reason === "idempotent_duplicate" || sent?.duplicate === true);
    if (!delivered) {
      console.error("[phone-enroll] sms send failed", {
        error: sent?.reason || sent?.error || "sms_failed",
        toMasked,
      });
      return { ok: false, status: 503, error: "sms_failed", message: PHONE_ENROLL_MESSAGES.sms_failed, toMasked };
    }
    console.log("[phone-enroll] code sent", { userId: user.id, toMasked });
    return {
      ok: true,
      sent: true,
      toMasked,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      message: `We sent a 6-digit code to ${toMasked}.`,
    };
  } catch (e) {
    console.error("[phone-enroll] sms send exception", {
      error: String(e?.message || e).slice(0, 120),
      toMasked,
    });
    return { ok: false, status: 503, error: "sms_failed", message: PHONE_ENROLL_MESSAGES.sms_failed, toMasked };
  }
}

/**
 * Confirm OTP and write verified phone on the SAME app_users row only.
 */
export async function verifyPhoneEnrollment(userId, code, deps = {}) {
  const id = String(userId || "").trim();
  const raw = String(code || "").trim().replace(/\s+/g, "");
  if (!id) {
    return { ok: false, status: 401, error: "unauthorized", message: PHONE_ENROLL_MESSAGES.unauthorized };
  }
  if (!/^\d{6,8}$/.test(raw)) {
    return { ok: false, status: 400, error: "code_required", message: PHONE_ENROLL_MESSAGES.code_required };
  }

  const now = nowMs(deps);
  const st = getRateState(id);
  if (st && st.cur.lockedUntil > now) {
    return { ok: false, status: 429, error: "locked", message: PHONE_ENROLL_MESSAGES.locked };
  }

  const bumpFailure = () => {
    if (!st) return;
    st.cur.verifyAttempts = Number(st.cur.verifyAttempts || 0) + 1;
    if (st.cur.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      st.cur.lockedUntil = now + LOCKOUT_MS;
    }
    enrollLimits.set(st.key, st.cur);
  };

  const user = await loadAppUserForEnrollment(id, deps);
  if (!user || isDisabledAccount(user)) {
    bumpFailure();
    return { ok: false, status: 401, error: "unauthorized", message: PHONE_ENROLL_MESSAGES.unauthorized };
  }

  const presentedHash = hashEnrollmentCode(user.id, raw);
  if (st?.cur.consumedHash && st.cur.consumedHash === presentedHash) {
    return { ok: false, status: 400, error: "reused", message: PHONE_ENROLL_MESSAGES.reused };
  }

  const stored = String(user.phone_enroll_otp_hash || "");
  if (!stored || stored !== presentedHash) {
    bumpFailure();
    const locked = st && st.cur.verifyAttempts >= MAX_VERIFY_ATTEMPTS;
    return {
      ok: false,
      status: locked ? 429 : 400,
      error: locked ? "locked" : "invalid_code",
      message: locked ? PHONE_ENROLL_MESSAGES.locked : PHONE_ENROLL_MESSAGES.invalid_code,
    };
  }

  const exp = user.phone_enroll_otp_expires_at ? Date.parse(user.phone_enroll_otp_expires_at) : 0;
  const q = queryFn(deps);
  if (!exp || Number.isNaN(exp) || now > exp) {
    await q(
      `UPDATE app_users
       SET phone_enroll_otp_hash = NULL,
           phone_enroll_otp_expires_at = NULL,
           phone_enroll_phone_e164 = NULL
       WHERE id = $1::uuid`,
      [user.id],
    );
    bumpFailure();
    return { ok: false, status: 400, error: "expired", message: PHONE_ENROLL_MESSAGES.expired };
  }

  const pending = String(user.phone_enroll_phone_e164 || "").trim();
  const parsed = normalizeEnrollmentPhone(pending);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: "phone_invalid", message: PHONE_ENROLL_MESSAGES.phone_invalid };
  }

  if (reservedForSuperAdmin(parsed.e164, user)) {
    return { ok: false, status: 400, error: "phone_reserved", message: PHONE_ENROLL_MESSAGES.phone_reserved };
  }

  const other = await findOtherVerifiedPhoneOwner(parsed.e164, user.id, deps);
  if (other) {
    return { ok: false, status: 409, error: "duplicate_phone", message: PHONE_ENROLL_MESSAGES.duplicate_phone };
  }

  try {
    const updated = await q(
      `UPDATE app_users
       SET phone = $2,
           phone_e164 = $3,
           phone_verified = true,
           phone_verified_at = NOW(),
           phone_enroll_otp_hash = NULL,
           phone_enroll_otp_expires_at = NULL,
           phone_enroll_phone_e164 = NULL
       WHERE id = $1::uuid
       RETURNING id, name, email, phone, phone_e164, phone_verified, phone_verified_at, role, apple_id,
                 profile_image_url, barber_id, business_id, preferred_language, created_at`,
      [user.id, parsed.e164, parsed.e164],
    );
    const row = updated.rows?.[0];
    if (!row) {
      return { ok: false, status: 404, error: "unauthorized", message: PHONE_ENROLL_MESSAGES.unauthorized };
    }
    if (st) {
      st.cur.verifyAttempts = 0;
      st.cur.lockedUntil = 0;
      st.cur.consumedHash = presentedHash;
      enrollLimits.set(st.key, st.cur);
    }
    const toMasked = maskPhoneForDisplay(parsed.e164);
    console.log("[phone-enroll] verified", { userId: user.id, toMasked });
    return {
      ok: true,
      phoneVerified: true,
      toMasked,
      appleIdPreserved: row.apple_id != null || user.apple_id != null,
      roleUnchanged: String(row.role || "") === String(user.role || ""),
      user: publicUserFromAppUser(row),
      message: "Phone verified.",
    };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/app_users_verified_phone_e164_uidx|unique/i.test(msg)) {
      return { ok: false, status: 409, error: "duplicate_phone", message: PHONE_ENROLL_MESSAGES.duplicate_phone };
    }
    console.error("[phone-enroll] verify update failed", { error: msg.slice(0, 120) });
    return { ok: false, status: 500, error: "server_error", message: PHONE_ENROLL_MESSAGES.server_error };
  }
}

export { CANONICAL_SUPER_ADMIN_EMAIL, CANONICAL_SUPER_ADMIN_SMS_E164 };
