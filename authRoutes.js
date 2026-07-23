import express from "express";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { normalizeEmail } from "./authStore.js";
import {
  completePasswordResetWithToken,
  requestPasswordResetForEmail,
} from "./passwordResetService.js";
import { dbQuery } from "./db.js";
import { comparePassword, hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";
import { jwtClaimsFromAppUser, publicUserFromAppUser } from "./authPlatformJwt.js";
import { writeSecurityAudit } from "./auditSecurity.js";
import { CANONICAL_SUPER_ADMIN_EMAIL, isForbiddenPublicSignupRole, isSuperAdminEmail, resolveRoleFromTrustedSource } from "./rolePolicy.js";
import { recordSignupAcceptanceBatch } from "./legalRoutes.js";
import { verifyAppleIdentityToken } from "./authAppleVerify.js";
import { deleteAppUserAccount } from "./accountDeletionService.js";
import {
  provisionBarberSignup,
  provisionShopOwnerSignup,
  resolveUserApprovalState,
} from "./signupProvisioningService.js";
import { validateSignupPhone } from "./phoneValidation.js";
import { ensureProviderTypeSchema } from "./providerTypeMigrations.js";
import {
  authRoleForProviderType,
  normalizeProviderType,
  resolveRegistrationProviderType,
} from "./providerTypesRegistry.cjs";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");

/** @deprecated Use CANONICAL_SUPER_ADMIN_EMAIL from rolePolicy.js */
export const ADMIN_EMAIL = CANONICAL_SUPER_ADMIN_EMAIL;

function getJwtSecret() {
  const s = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || "").trim();
  if (s) return s;
  // Safe-ish dev fallback; logs to console so you know to set it.
  console.warn("[auth] Missing AUTH_JWT_SECRET/JWT_SECRET. Using insecure dev fallback.");
  return "dev-insecure-secret-change-me";
}

function signTokenForAppUser(userRow) {
  const claims = jwtClaimsFromAppUser(userRow);
  const secret = getJwtSecret();
  return jwt.sign(claims, secret, { expiresIn: "30d" });
}

/** Issue HS256 JWT for an `app_users` row (onboarding, auth, etc.). */
export function issueAppUserJwt(userRow) {
  return signTokenForAppUser(userRow);
}

function postLoginRedirectFromClaims(claims) {
  if (claims?.isOwner === true && claims?.isSuperAdmin === true) return "admin_dashboard";
  return "app";
}

/** Normalize JWT payload to a consistent req.user shape (id, barberId, etc.). */
export function normalizeAuthUser(payload) {
  if (!payload || typeof payload !== "object") return null;
  const id = String(payload.id || payload.sub || "").trim();
  if (!id) return null;
  const role = String(payload.role || "").trim().toLowerCase();
  const normalized = { ...payload, id, sub: id };
  if (normalized.isSuperAdmin == null && role === "super_admin") {
    normalized.isSuperAdmin = true;
  }
  if (normalized.barberId == null && payload.barber_id != null) {
    normalized.barberId = payload.barber_id;
  }
  return normalized;
}

/**
 * Validates Bearer JWT (HS256). Legacy tokens without isSuperAdmin are normalized when role is super_admin.
 */
export function resolveAuthPayload(token, options = {}) {
  const { allowExpired = false, graceSeconds = 0 } = options || {};
  let t = String(token || "").trim();
  if (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  if (!t) return null;
  try {
    const secret = getJwtSecret();
    const verifyOpts = {};
    if (allowExpired) verifyOpts.ignoreExpiration = true;
    const p = jwt.verify(t, secret, verifyOpts);
    const normalized = normalizeAuthUser(p);
    if (!normalized) return null;
    if (allowExpired && normalized.exp) {
      const expMs = Number(normalized.exp) * 1000;
      if (Number.isFinite(expMs) && expMs + graceSeconds * 1000 < Date.now()) return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export function extractBearerToken(authorizationHeader) {
  const h = String(authorizationHeader || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

export function requireAuth(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ error: "unauthorized", message: "Missing Bearer token" });
  const payload = resolveAuthPayload(token);
  if (!payload) return res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
  req.user = payload;
  return next();
}

async function loadAppUserForTokenRefresh(userId) {
  const found = await dbQuery(
    `SELECT id, name, email, phone, profile_image_url, role, barber_id, business_id, account_status, created_at
     FROM app_users WHERE id = $1::uuid LIMIT 1`,
    [String(userId)],
  );
  return found.rows?.[0] || null;
}

async function issueSessionResponse(userRow) {
  const claims = jwtClaimsFromAppUser(userRow);
  const token = signTokenForAppUser(userRow);
  const publicUser = publicUserFromAppUser(userRow);
  const approval = await resolveUserApprovalState(userRow);
  const redirect = postLoginRedirectFromClaims(claims);
  return {
    ok: true,
    success: true,
    token,
    user: { ...publicUser, ...approval },
    approvalPending: approval.limitedAccess === true,
    redirect,
  };
}

/**
 * For CMS-style routes: allow `Authorization: Bearer …` OR `x-admin-key` matching `ADMIN_SECRET`
 * (same pattern as `requireAdminOrSuper` / barber `manage` middleware).
 */
export function requireAuthOrAdminSecret(req, res, next) {
  const adminKey = String(req.get("x-admin-key") || "").trim();
  const expected = String(process.env.ADMIN_SECRET || "").trim();
  if (expected && adminKey && adminKey === expected) {
    req.user = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "admin@api-key",
      role: "super_admin",
      isSuperAdmin: true,
    };
    return next();
  }
  return requireAuth(req, res, next);
}

export function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    const r = String(req.user?.role || "").trim();
    if (allowed.includes(r)) {
      return next();
    }
    if (req.user?.isSuperAdmin === true && (allowed.includes("super_admin") || allowed.includes("admin"))) {
      return next();
    }
    return res.status(403).json({ message: "Access denied" });
  };
}

/** Google ID token `aud` must match one of these (web + optional native Expo clients). */
function getGoogleOAuthClientIds() {
  const web = String(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_WEB_CLIENT_ID || "").trim();
  const ios = String(process.env.GOOGLE_IOS_CLIENT_ID || process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || "").trim();
  const android = String(process.env.GOOGLE_ANDROID_CLIENT_ID || process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || "").trim();
  const list = [web, ios, android].filter(Boolean);
  return [...new Set(list)];
}

function randomPlaceholderPasswordForOAuth() {
  let candidate = "";
  for (let i = 0; i < 5; i++) {
    candidate = `Aa9!${crypto.randomBytes(24).toString("base64url")}`;
    const v = validatePasswordStrength(candidate);
    if (v.valid) return candidate;
  }
  return `Aa9!${crypto.randomBytes(32).toString("hex")}!`;
}

export function createAuthRouter({ sendEmail }) {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const roleCandidates = [body.role, body.accountType, body.account_type, body.providerType, body.provider_type].filter(
        (v) => v != null && String(v).trim() !== "",
      );
      for (const raw of roleCandidates) {
        if (isForbiddenPublicSignupRole(raw)) {
          return res.status(403).json({
            error: "forbidden_role",
            message: "Super Admin accounts cannot be created through registration.",
          });
        }
      }
      if (isSuperAdminEmail(email)) {
        return res.status(403).json({
          error: "email_reserved",
          message: "This email is reserved for the platform owner account.",
        });
      }

      await ensureProviderTypeSchema();

      const providerTypeRaw = resolveRegistrationProviderType(body);
      const providerType =
        providerTypeRaw && providerTypeRaw !== "customer" ? normalizeProviderType(providerTypeRaw) : null;
      const roleFromProvider = providerType ? authRoleForProviderType(providerType) : null;
      const role = roleFromProvider || resolveRoleFromTrustedSource(req);
      if (!role) {
        return res.status(403).json({
          error: "forbidden_role",
          message: "Super Admin accounts cannot be created through registration.",
        });
      }
      if (role !== "user" && role !== "barber" && role !== "shop_owner") {
        return res.status(400).json({
          error: "invalid_role",
          message: "Account type must be client, service provider, or shop admin.",
        });
      }

      const { normalizePreferredLanguage, isMultiLanguageDropdownV2Enabled } = await import(
        "./shared/multiLanguageFlag.js"
      );
      const preferredLanguage =
        normalizePreferredLanguage(body.language || body.preferredLanguage || body.preferred_language || "en", {
          allowV2: true,
        }) || "en";
      void isMultiLanguageDropdownV2Enabled;

      if (!name) return res.status(400).json({ error: "name_required", message: "Name is required" });
      if (!email) return res.status(400).json({ error: "email_required", message: "Email is required" });
      const pwCheck = validatePasswordStrength(password);
      if (!pwCheck.valid) {
        return res.status(400).json({ error: "weak_password", message: pwCheck.message });
      }

      const phoneRaw = String(req.body?.phone || "").trim();
      const phoneCheck = validateSignupPhone(phoneRaw);
      if (!phoneCheck.ok) {
        return res.status(400).json({ error: phoneCheck.error, message: phoneCheck.message });
      }
      const phone = phoneCheck.display;
      const shopName = String(req.body?.shopName || req.body?.shop_name || "").trim();
      const businessName = String(req.body?.businessName || req.body?.business_name || shopName).trim();
      const address = String(req.body?.address || req.body?.location || "").trim();
      const city = String(req.body?.city || "").trim();
      const state = String(req.body?.state || "").trim();

      if (role === "barber") {
        if (!shopName) return res.status(400).json({ error: "shop_name_required", message: "Shop name is required." });
        if (!address && !(city && state)) {
          return res.status(400).json({
            error: "location_required",
            message: "Location (address or city and state) is required.",
          });
        }
      }
      if (role === "shop_owner") {
        if (!businessName) {
          return res.status(400).json({ error: "business_name_required", message: "Shop name is required." });
        }
        if (!address) return res.status(400).json({ error: "address_required", message: "Shop address is required." });
        if (!city) return res.status(400).json({ error: "city_required", message: "City is required." });
        if (!state) return res.status(400).json({ error: "state_required", message: "State is required." });
      }

      const passwordHash = await hashPassword(password);
      const initialAccountStatus = role === "user" ? "active" : "pending";
      const created = await dbQuery(
        `INSERT INTO app_users (name, email, password_hash, role, phone, account_status, provider_type, preferred_language)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, email, role, phone, barber_id, business_id, account_status, provider_type, preferred_language, created_at`,
        [
          name || null,
          email,
          passwordHash,
          role,
          phone,
          initialAccountStatus,
          providerType || (role === "shop_owner" ? "shop_owner" : null),
          preferredLanguage,
        ],
      );
      const user = created.rows?.[0];
      if (!user?.id) throw new Error("user_insert_failed");

      let approvalPending = false;
      let adminSignupEmailSent = false;
      let adminSignupEmailMessageId = null;
      try {
        if (role === "barber") {
          const provisioned = await provisionBarberSignup({
            userId: user.id,
            name,
            email,
            phone,
            shopName,
            location: address,
            address,
            city,
            state,
            providerType: providerType || "barber",
          });
          approvalPending = true;
          adminSignupEmailSent = Boolean(provisioned?.adminEmailSent);
          adminSignupEmailMessageId = provisioned?.adminEmailMessageId || null;
        } else if (role === "shop_owner") {
          const provisioned = await provisionShopOwnerSignup({
            userId: user.id,
            name,
            email,
            phone,
            businessName,
            address,
            city,
            state,
          });
          approvalPending = true;
          adminSignupEmailSent = Boolean(provisioned?.adminEmailSent);
          adminSignupEmailMessageId = provisioned?.adminEmailMessageId || null;
        }
      } catch (provisionErr) {
        await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid`, [user.id]).catch(() => {});
        throw provisionErr;
      }

      const refreshed = await dbQuery(
        `SELECT id, name, email, phone, profile_image_url, role, barber_id, business_id, account_status, created_at
         FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [user.id],
      );
      const finalUser = refreshed.rows?.[0] || user;
      const claims = jwtClaimsFromAppUser(finalUser);
      const token = signTokenForAppUser(finalUser);
      const publicUser = publicUserFromAppUser(finalUser);
      const approval = await resolveUserApprovalState(finalUser);
      console.log("[auth] register_success", {
        email: publicUser.email,
        role: publicUser.role,
        redirect: postLoginRedirectFromClaims(claims),
        approvalPending,
      });

      // Best-effort: persist signup-time legal acceptances if the client sent them.
      // Never fails registration — auth flow is the protected path.
      try {
        const list = Array.isArray(req.body?.acceptances) ? req.body.acceptances : [];
        if (user?.id && list.length > 0) {
          const ip =
            (req.headers["x-forwarded-for"] || "")
              .toString()
              .split(",")[0]
              .trim() ||
            req.ip ||
            null;
          const userAgent =
            typeof req.headers["user-agent"] === "string"
              ? req.headers["user-agent"].slice(0, 320)
              : null;
          await recordSignupAcceptanceBatch({
            userId: String(user.id),
            acceptances: list,
            appVersion:
              typeof req.body?.appVersion === "string" && req.body.appVersion.trim()
                ? req.body.appVersion.trim().slice(0, 64)
                : null,
            platform:
              typeof req.body?.platform === "string" && req.body.platform.trim()
                ? req.body.platform.trim().slice(0, 32)
                : null,
            ip,
            userAgent,
          });
        }
      } catch (acceptErr) {
        console.warn("[auth] register acceptance log failed:", acceptErr?.message || acceptErr);
      }

      // HubSpot CRM sync — fire-and-forget; never blocks or fails registration.
      void import("./hubspotService.js")
        .then((m) =>
          m.enqueueContactSync(
            {
              id: publicUser.id,
              email: publicUser.email,
              name: publicUser.name,
              phone: publicUser.phone,
              role: publicUser.role,
              lifecycleStage: "registered",
              registeredAt: publicUser.createdAt || new Date().toISOString(),
            },
            { reason: "register" },
          ),
        )
        .catch((hubspotErr) =>
          console.warn("[hubspot] register enqueue failed:", hubspotErr?.message || hubspotErr),
        );

      return res.json({
        ok: true,
        success: true,
        token,
        user: { ...publicUser, ...approval },
        approvalPending,
        adminSignupEmailSent,
        adminSignupEmailMessageId,
        redirect: postLoginRedirectFromClaims(claims),
      });
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("duplicate") || e?.code === "23505") {
        return res.status(409).json({ error: "email_exists", message: "Email is already registered" });
      }
      console.error("[auth] register error:", e);
      const hint = String(e?.message || "").slice(0, 200) || null;
      return res.status(500).json({
        ok: false,
        success: false,
        error: "server_error",
        message: "Register failed",
        hint,
      });
    }
  });

  router.post("/login", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      if (!email || !password) {
        return res.status(400).json({ error: "missing_credentials", message: "Email and password required" });
      }
      const found = await dbQuery(
        "SELECT id, name, email, password_hash, role, barber_id, business_id, created_at FROM app_users WHERE lower(trim(email::text)) = $1 LIMIT 1",
        [email]
      );
      const user = found.rows?.[0] || null;
      if (!user) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "user_not_found",
          message: "No account exists for this email. Create an account or check the spelling.",
        });
      }
      const passwordOk = await comparePassword(password, user.password_hash);
      if (!passwordOk) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "invalid_password",
          message: "Wrong password. Try again or use Forgot password.",
        });
      }

      const claims = jwtClaimsFromAppUser(user);
      const token = signTokenForAppUser(user);
      const publicUser = publicUserFromAppUser(user);
      const redirect = postLoginRedirectFromClaims(claims);
      console.log("[auth] login_success", {
        email: publicUser.email,
        role: publicUser.role,
        isOwner: publicUser.isOwner,
        isSuperAdmin: publicUser.isSuperAdmin,
        redirect,
      });
      void writeSecurityAudit({
        eventType: "login_success",
        actorUserId: user.id,
        actorEmail: publicUser.email,
        req,
        metadata: { role: publicUser.role, redirect },
      });
      return res.json({
        ok: true,
        success: true,
        token,
        user: publicUser,
        redirect,
      });
    } catch (e) {
      console.error("[auth] login error:", e);
      return res.status(500).json({ ok: false, success: false, error: "server_error", message: "Login failed" });
    }
  });

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const id = String(req.user?.id || "").trim();
      if (!id) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "unauthorized",
          message: "Invalid token subject",
        });
      }
      const user = await loadAppUserForTokenRefresh(id);
      if (!user) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "user_not_found",
          message: "Account no longer exists.",
        });
      }
      const session = await issueSessionResponse(user);
      return res.json(session);
    } catch (e) {
      console.error("[auth] /me error:", e);
      return res.status(500).json({
        ok: false,
        success: false,
        error: "server_error",
        message: "Session lookup failed",
      });
    }
  });

  /** Re-issue JWT from a valid (or recently expired) session — keeps mobile/web in sync. */
  router.post("/refresh", async (req, res) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Missing Bearer token" });
      }
      let payload = resolveAuthPayload(token);
      if (!payload) {
        payload = resolveAuthPayload(token, { allowExpired: true, graceSeconds: 7 * 24 * 60 * 60 });
      }
      if (!payload?.id) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid or expired token" });
      }
      const user = await loadAppUserForTokenRefresh(payload.id);
      if (!user) {
        return res.status(401).json({ ok: false, error: "user_not_found", message: "Account no longer exists." });
      }
      const session = await issueSessionResponse(user);
      return res.json(session);
    } catch (e) {
      console.error("[auth] /refresh error:", e);
      return res.status(500).json({ ok: false, error: "server_error", message: "Session refresh failed" });
    }
  });

  router.patch("/profile", requireAuth, async (req, res) => {
    try {
      const id = String(req.user?.id || "").trim();
      if (!id) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid session" });
      }
      const body = req.body || {};
      const name = body.name != null ? String(body.name).trim().slice(0, 255) : null;
      const phoneRaw = body.phone != null ? String(body.phone).replace(/\D/g, "").slice(0, 15) : null;
      const profileImageUrl =
        body.profileImageUrl != null ? String(body.profileImageUrl).trim().slice(0, 2048) : null;
      const dateOfBirthRaw =
        body.dateOfBirth != null || body.date_of_birth != null
          ? String(body.dateOfBirth ?? body.date_of_birth).trim().slice(0, 10)
          : null;
      const preferredLanguageRaw =
        body.preferredLanguage != null || body.preferred_language != null || body.language != null
          ? String(body.preferredLanguage ?? body.preferred_language ?? body.language).trim()
          : null;

      if (name !== null && !name) {
        return res.status(400).json({ ok: false, error: "name_required", message: "Name cannot be empty" });
      }
      if (dateOfBirthRaw != null && dateOfBirthRaw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthRaw)) {
        return res.status(400).json({
          ok: false,
          error: "date_of_birth_invalid",
          message: "dateOfBirth must be YYYY-MM-DD",
        });
      }

      let preferredLanguage = null;
      if (preferredLanguageRaw != null && preferredLanguageRaw !== "") {
        const { normalizePreferredLanguage, isMultiLanguageDropdownV2Enabled } = await import(
          "./shared/multiLanguageFlag.js"
        );
        preferredLanguage = normalizePreferredLanguage(preferredLanguageRaw, {
          allowV2: isMultiLanguageDropdownV2Enabled(),
        });
        // Always allow saving a previously-supported V2 code even if flag is off (no preference wipe).
        if (!preferredLanguage) {
          preferredLanguage = normalizePreferredLanguage(preferredLanguageRaw, { allowV2: true });
        }
        if (!preferredLanguage) {
          return res.status(400).json({
            ok: false,
            error: "language_unsupported",
            message: "Unsupported preferred language",
          });
        }
      }

      const sets = [];
      const params = [];
      let i = 1;
      if (name !== null) {
        sets.push(`name = $${i++}`);
        params.push(name);
      }
      if (body.phone !== undefined) {
        sets.push(`phone = $${i++}`);
        params.push(phoneRaw || null);
      }
      if (body.profileImageUrl !== undefined) {
        sets.push(`profile_image_url = $${i++}`);
        params.push(profileImageUrl || null);
      }
      if (body.dateOfBirth !== undefined || body.date_of_birth !== undefined) {
        sets.push(`date_of_birth = $${i++}::date`);
        params.push(dateOfBirthRaw || null);
      }
      if (preferredLanguage) {
        sets.push(`preferred_language = $${i++}`);
        params.push(preferredLanguage);
      }
      if (!sets.length) {
        return res.status(400).json({ ok: false, error: "no_fields", message: "No profile fields to update" });
      }
      params.push(id);
      const updated = await dbQuery(
        `UPDATE app_users SET ${sets.join(", ")} WHERE id = $${i}::uuid
         RETURNING id, name, email, phone, profile_image_url, date_of_birth, role, barber_id, business_id, preferred_language, created_at`,
        params,
      );
      const user = updated.rows?.[0];
      if (!user) {
        return res.status(404).json({ ok: false, error: "user_not_found", message: "Account not found" });
      }
      const publicUser = publicUserFromAppUser(user);
      // HubSpot CRM sync — fire-and-forget; never blocks profile updates.
      void import("./hubspotService.js")
        .then((m) =>
          m.enqueueContactSync(
            {
              id: publicUser.id,
              email: publicUser.email,
              name: publicUser.name,
              phone: publicUser.phone,
              role: publicUser.role,
              dateOfBirth: publicUser.dateOfBirth,
            },
            { reason: "profile_update" },
          ),
        )
        .catch((hubspotErr) =>
          console.warn("[hubspot] profile enqueue failed:", hubspotErr?.message || hubspotErr),
        );
      return res.json({
        ok: true,
        success: true,
        user: publicUser,
      });
    } catch (e) {
      console.error("[auth] PATCH /profile error:", e);
      return res.status(500).json({ ok: false, error: "server_error", message: "Profile update failed" });
    }
  });

  router.get("/my-bookings", requireAuth, async (req, res) => {
    try {
      const id = String(req.user?.id || "").trim();
      const email = String(req.user?.email || "").trim();
      if (!id) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid session" });
      }
      const r = await dbQuery(
        `SELECT id, customer_name, customer_email, barber_name, service,
                date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                payment_status, booking_status, total_amount, platform_fee,
                paypal_order_id, created_at
         FROM bookings
         WHERE deleted_at IS NULL
           AND (
             user_id = $1::uuid
             OR (customer_email IS NOT NULL AND lower(trim(customer_email)) = lower(trim($2)))
           )
         ORDER BY created_at DESC
         LIMIT 100`,
        [id, email || ""],
      );
      return res.json({ ok: true, bookings: r.rows || [] });
    } catch (e) {
      console.error("[auth] GET /my-bookings error:", e);
      return res.status(500).json({ ok: false, error: "server_error", message: "Could not load bookings" });
    }
  });

  router.post("/google", async (req, res) => {
    try {
      const allowedAud = getGoogleOAuthClientIds();
      if (!allowedAud.length) {
        return res.status(503).json({
          ok: false,
          success: false,
          error: "google_oauth_not_configured",
          message:
            "Server is missing GOOGLE_CLIENT_ID (Google Cloud → Web application OAuth client ID). Add it on Render, then redeploy.",
        });
      }

      const idToken = String(req.body?.idToken || "").trim();
      if (!idToken) {
        return res.status(400).json({
          ok: false,
          success: false,
          error: "idToken_required",
          message: "Missing Google credential. Try signing in again.",
        });
      }

      let ti;
      try {
        const r = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        );
        ti = await r.json().catch(() => ({}));
        if (!r.ok || String(ti?.error || "").trim()) {
          console.error("[auth/google] tokeninfo failed", r.status, ti);
          return res.status(401).json({
            ok: false,
            success: false,
            error: "google_token_invalid",
            message: ti?.error_description || ti?.error || "Google could not verify this sign-in.",
          });
        }
      } catch (e) {
        console.error("[auth/google] tokeninfo unreachable", e?.message || e);
        return res.status(502).json({
          ok: false,
          success: false,
          error: "google_verify_unreachable",
          message: "Could not reach Google to verify sign-in. Check network and try again.",
        });
      }

      const aud = String(ti.aud || "").trim();
      if (!allowedAud.includes(aud)) {
        console.error("[auth/google] aud mismatch", { aud, allowedAud });
        return res.status(401).json({
          ok: false,
          success: false,
          error: "google_audience_mismatch",
          message:
            "Google client ID does not match the server. Set GOOGLE_CLIENT_ID to your Web OAuth client ID (same audience as the app’s ID token).",
        });
      }

      const googleId = String(ti.sub || "").trim();
      const email = normalizeEmail(ti.email);
      const name = String(ti.name || ti.given_name || "").trim();
      const ev = ti.email_verified;
      const emailVerified = ev === true || ev === "true" || ev === "True" || ev === 1 || ev === "1";

      if (!googleId || !email) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "google_payload_invalid",
          message: "Google did not return enough profile data to sign you in.",
        });
      }

      if (!emailVerified) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "google_email_unverified",
          message: "Verify this email in your Google account, then try again.",
        });
      }

      const byGoogle = await dbQuery(
        "SELECT id, name, email, password_hash, role, barber_id, business_id, google_id FROM app_users WHERE google_id = $1 LIMIT 1",
        [googleId],
      );
      const userByGoogle = byGoogle.rows?.[0] || null;
      if (userByGoogle) {
        const claims = jwtClaimsFromAppUser(userByGoogle);
        const token = signTokenForAppUser(userByGoogle);
        const publicUser = publicUserFromAppUser(userByGoogle);
        console.log("[auth] google_success", {
          email: publicUser.email,
          role: publicUser.role,
          redirect: postLoginRedirectFromClaims(claims),
        });
        return res.json({
          ok: true,
          success: true,
          token,
          user: publicUser,
          redirect: postLoginRedirectFromClaims(claims),
        });
      }

      const byEmail = await dbQuery(
        "SELECT id, name, email, password_hash, role, barber_id, business_id, google_id FROM app_users WHERE lower(trim(email::text)) = $1 LIMIT 1",
        [email],
      );
      const userByEmail = byEmail.rows?.[0] || null;
      if (userByEmail) {
        if (userByEmail.google_id && String(userByEmail.google_id) !== googleId) {
          return res.status(409).json({
            ok: false,
            success: false,
            error: "google_account_conflict",
            message: "This email is already linked to a different Google account.",
          });
        }
        await dbQuery("UPDATE app_users SET google_id = $1 WHERE id = $2::uuid", [googleId, userByEmail.id]);
        const refreshed = { ...userByEmail, google_id: googleId };
        const claims = jwtClaimsFromAppUser(refreshed);
        const token = signTokenForAppUser(refreshed);
        const publicUser = publicUserFromAppUser(refreshed);
        console.log("[auth] google_success", {
          email: publicUser.email,
          role: publicUser.role,
          redirect: postLoginRedirectFromClaims(claims),
        });
        return res.json({
          ok: true,
          success: true,
          token,
          user: publicUser,
          redirect: postLoginRedirectFromClaims(claims),
        });
      }

      const pw = randomPlaceholderPasswordForOAuth();
      const passwordHash = await hashPassword(pw);
      const created = await dbQuery(
        `INSERT INTO app_users (name, email, password_hash, role, google_id)
         VALUES ($1, $2, $3, 'user', $4)
         RETURNING id, name, email, role, barber_id, business_id, google_id`,
        [name || email.split("@")[0] || "User", email, passwordHash, googleId],
      );
      const nu = created.rows?.[0];
      if (!nu) {
        return res.status(500).json({
          ok: false,
          success: false,
          error: "google_create_user_failed",
          message: "Could not create your account. Try again.",
        });
      }
      const claims = jwtClaimsFromAppUser(nu);
      const token = signTokenForAppUser(nu);
      const publicUser = publicUserFromAppUser(nu);
      console.log("[auth] google_success", {
        email: publicUser.email,
        role: publicUser.role,
        redirect: postLoginRedirectFromClaims(claims),
      });
      void import("./hubspotService.js")
        .then((m) =>
          m.enqueueContactSync(
            {
              id: publicUser.id,
              email: publicUser.email,
              name: publicUser.name,
              phone: publicUser.phone,
              role: publicUser.role,
              lifecycleStage: "registered",
              registeredAt: publicUser.createdAt || new Date().toISOString(),
            },
            { reason: "google_register" },
          ),
        )
        .catch((hubspotErr) =>
          console.warn("[hubspot] google enqueue failed:", hubspotErr?.message || hubspotErr),
        );
      return res.json({
        ok: true,
        success: true,
        token,
        user: publicUser,
        redirect: postLoginRedirectFromClaims(claims),
      });
    } catch (e) {
      console.error("[auth/google] error:", e?.stack || e);
      return res.status(500).json({
        ok: false,
        success: false,
        error: "server_error",
        message: "Google sign-in failed",
      });
    }
  });

  router.post("/apple", async (req, res) => {
    try {
      const identityToken = String(req.body?.identityToken || "").trim();
      if (!identityToken) {
        return res.status(400).json({
          ok: false,
          success: false,
          error: "identityToken_required",
          message: "Missing Apple credential. Try signing in again.",
        });
      }

      let verified;
      try {
        verified = await verifyAppleIdentityToken(identityToken);
      } catch (e) {
        const msg = String(e?.message || "apple_token_invalid");
        console.error("[auth/apple] verify failed", msg);
        return res.status(401).json({
          ok: false,
          success: false,
          error: "apple_token_invalid",
          message: "Apple could not verify this sign-in. Try again.",
        });
      }

      const appleId = String(verified.sub || "").trim();
      const emailFromToken = verified.email ? normalizeEmail(verified.email) : "";
      const emailFromClient = normalizeEmail(req.body?.email);
      const email = emailFromToken || emailFromClient;
      const name = String(req.body?.fullName || req.body?.name || "").trim();

      if (!appleId) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "apple_payload_invalid",
          message: "Apple did not return enough profile data to sign you in.",
        });
      }

      const byApple = await dbQuery(
        "SELECT id, name, email, password_hash, role, barber_id, business_id, apple_id FROM app_users WHERE apple_id = $1 LIMIT 1",
        [appleId],
      );
      const userByApple = byApple.rows?.[0] || null;
      if (userByApple) {
        const claims = jwtClaimsFromAppUser(userByApple);
        const token = signTokenForAppUser(userByApple);
        const publicUser = publicUserFromAppUser(userByApple);
        console.log("[auth] apple_success", {
          email: publicUser.email,
          role: publicUser.role,
          redirect: postLoginRedirectFromClaims(claims),
        });
        return res.json({
          ok: true,
          success: true,
          token,
          user: publicUser,
          redirect: postLoginRedirectFromClaims(claims),
        });
      }

      if (!email) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "apple_email_required",
          message:
            "Apple did not share an email for this sign-in. Choose Share My Email on the Apple prompt, or sign in with email.",
        });
      }

      if (verified.email && verified.email_verified === false) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: "apple_email_unverified",
          message: "Verify this email in your Apple ID, then try again.",
        });
      }

      const byEmail = await dbQuery(
        "SELECT id, name, email, password_hash, role, barber_id, business_id, apple_id FROM app_users WHERE lower(trim(email::text)) = $1 LIMIT 1",
        [email],
      );
      const userByEmail = byEmail.rows?.[0] || null;
      if (userByEmail) {
        if (userByEmail.apple_id && String(userByEmail.apple_id) !== appleId) {
          return res.status(409).json({
            ok: false,
            success: false,
            error: "apple_account_conflict",
            message: "This email is already linked to a different Apple ID.",
          });
        }
        await dbQuery("UPDATE app_users SET apple_id = $1 WHERE id = $2::uuid", [appleId, userByEmail.id]);
        const refreshed = { ...userByEmail, apple_id: appleId };
        const claims = jwtClaimsFromAppUser(refreshed);
        const token = signTokenForAppUser(refreshed);
        const publicUser = publicUserFromAppUser(refreshed);
        console.log("[auth] apple_success", {
          email: publicUser.email,
          role: publicUser.role,
          redirect: postLoginRedirectFromClaims(claims),
        });
        return res.json({
          ok: true,
          success: true,
          token,
          user: publicUser,
          redirect: postLoginRedirectFromClaims(claims),
        });
      }

      const pw = randomPlaceholderPasswordForOAuth();
      const passwordHash = await hashPassword(pw);
      const created = await dbQuery(
        `INSERT INTO app_users (name, email, password_hash, role, apple_id)
         VALUES ($1, $2, $3, 'user', $4)
         RETURNING id, name, email, role, barber_id, business_id, apple_id`,
        [name || email.split("@")[0] || "User", email, passwordHash, appleId],
      );
      const nu = created.rows?.[0];
      if (!nu) {
        return res.status(500).json({
          ok: false,
          success: false,
          error: "apple_create_user_failed",
          message: "Could not create your account. Try again.",
        });
      }
      const claims = jwtClaimsFromAppUser(nu);
      const token = signTokenForAppUser(nu);
      const publicUser = publicUserFromAppUser(nu);
      console.log("[auth] apple_success", {
        email: publicUser.email,
        role: publicUser.role,
        redirect: postLoginRedirectFromClaims(claims),
      });
      void import("./hubspotService.js")
        .then((m) =>
          m.enqueueContactSync(
            {
              id: publicUser.id,
              email: publicUser.email,
              name: publicUser.name,
              phone: publicUser.phone,
              role: publicUser.role,
              lifecycleStage: "registered",
              registeredAt: publicUser.createdAt || new Date().toISOString(),
            },
            { reason: "apple_register" },
          ),
        )
        .catch((hubspotErr) =>
          console.warn("[hubspot] apple enqueue failed:", hubspotErr?.message || hubspotErr),
        );
      return res.json({
        ok: true,
        success: true,
        token,
        user: publicUser,
        redirect: postLoginRedirectFromClaims(claims),
      });
    } catch (e) {
      console.error("[auth/apple] error:", e?.stack || e);
      return res.status(500).json({
        ok: false,
        success: false,
        error: "server_error",
        message: "Apple sign-in failed",
      });
    }
  });

  router.delete("/account", requireAuth, async (req, res) => {
    try {
      const id = String(req.user?.id || "").trim();
      if (!id) {
        return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid session" });
      }
      const result = await deleteAppUserAccount(id);
      if (!result.ok) {
        const status = result.error === "account_protected" ? 403 : 400;
        return res.status(status).json({
          ok: false,
          success: false,
          error: result.error,
          message: result.message || "Account could not be deleted.",
        });
      }
      void writeSecurityAudit({
        eventType: "account_deleted",
        actorUserId: id,
        actorEmail: String(req.user?.email || ""),
        req,
        metadata: { source: String(req.headers["x-client-source"] || "app").slice(0, 64) },
      });
      return res.json({ ok: true, success: true, message: "Account deleted." });
    } catch (e) {
      console.error("[auth] DELETE /account error:", e);
      return res.status(500).json({
        ok: false,
        success: false,
        error: "server_error",
        message: "Account deletion failed",
      });
    }
  });

  const NEUTRAL_RESET_MESSAGE =
    "If an account exists for that email, a password reset link is on the way.";

  router.post("/forgot-password", async (req, res) => {
    try {
      const email = String(req.body?.email || "");
      const result = await requestPasswordResetForEmail(email, { sendEmail });

      if (!result.ok) {
        if (result.error === "email_required") {
          return res.status(400).json({ error: result.error, message: result.message });
        }
        if (result.error === "email_failed" || result.error === "email_unconfigured") {
          return res.status(503).json({ error: result.error, message: result.message });
        }
        return res.status(500).json({ error: "server_error", message: result.message || "Could not start reset flow" });
      }

      return res.json({ success: true, message: NEUTRAL_RESET_MESSAGE });
    } catch (e) {
      console.error("[auth] forgot-password error:", e);
      return res.status(500).json({ error: "server_error", message: "Could not start reset flow" });
    }
  });

  router.post("/reset-password", async (req, res) => {
    try {
      const token = String(req.body?.token || "").trim();
      const newPassword = String(req.body?.newPassword || req.body?.password || "");
      const result = await completePasswordResetWithToken(token, newPassword);

      if (!result.ok) {
        const code = result.error || "reset_failed";
        const status =
          code === "weak_password" || code === "token_required" || code === "invalid_token" || code === "token_expired"
            ? 400
            : 500;
        return res.status(status).json({ error: code, message: result.message });
      }

      return res.json({ success: true, message: "Password updated" });
    } catch (e) {
      console.error("[auth] reset-password error:", e);
      return res.status(500).json({ error: "server_error", message: "Reset failed" });
    }
  });

  return router;
}

