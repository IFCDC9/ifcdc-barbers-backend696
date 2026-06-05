import crypto from "node:crypto";
import express from "express";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import { ALLOWED_ROLES } from "./authDbMigrations.js";
import { normalizeEmail } from "./authStore.js";
import { CANONICAL_SUPER_ADMIN_EMAIL, isSuperAdminEmail } from "./rolePolicy.js";

const ACTIVE_INVITE_STATUSES = ["pending", "sent"];
const SMS_UNAVAILABLE_MESSAGE = "SMS invite unavailable right now.";

function rowToInvite(row) {
  return {
    id: String(row.id),
    inviteToken: row.invite_token,
    email: row.email,
    name: row.name,
    phone: row.phone || null,
    role: row.role || "user",
    businessId: row.business_id ?? null,
    businessName: row.business_name ?? null,
    welcomeNote: row.welcome_note || null,
    status: row.status || "pending",
    onboardingState: row.onboarding_state || "invite_pending",
    sendEmail: Boolean(row.send_email),
    sendSms: Boolean(row.send_sms),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  };
}

async function resolveUserManagementScope(req, res) {
  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) {
    res.status(401).json({ ok: false, message: "Missing Bearer token" });
    return null;
  }
  const payload = resolveAuthPayload(token);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Invalid or expired token" });
    return null;
  }
  req.user = payload;

  if (isJwtGlobalSuperScope(payload)) {
    return { all: true, actorId: String(payload.id || ""), actorEmail: String(payload.email || "") };
  }

  const role = String(payload?.role || "").trim().toLowerCase();
  if (role === "shop_owner") {
    const r = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(payload.id)]);
    const bid = r.rows?.[0]?.business_id;
    const businessId = bid != null && bid !== "" ? Number(bid) : NaN;
    if (!Number.isFinite(businessId)) {
      res.status(403).json({ ok: false, message: "Shop owner account is not linked to a business." });
      return null;
    }
    return { all: false, businessId, actorId: String(payload.id || ""), actorEmail: String(payload.email || "") };
  }

  res.status(403).json({ ok: false, message: "Access denied" });
  return null;
}

function normalizeInviteRole(raw) {
  let role = String(raw || "user").trim().toLowerCase();
  if (role === "customer") role = "user";
  return role;
}

function validateInviteRole(scope, email, role) {
  if (!ALLOWED_ROLES.includes(role)) {
    return { ok: false, message: "Invalid role." };
  }
  if (role === "super_admin" && !isSuperAdminEmail(email)) {
    return { ok: false, message: "Super Admin can only be invited for the master IFCDC account." };
  }
  if (isSuperAdminEmail(email) && role !== "super_admin") {
    return { ok: false, message: "The master IFCDC account must be invited as Super Admin." };
  }
  if (!scope.all && (role === "admin" || role === "super_admin")) {
    return { ok: false, message: "You cannot invite users with elevated platform roles." };
  }
  if (!scope.all && !["user", "barber", "shop_owner"].includes(role)) {
    return { ok: false, message: "You cannot assign that role." };
  }
  return { ok: true };
}

const { resolvePublicWebOrigin, buildInviteAcceptUrl } = require("./publicSiteConfig.cjs");

function inviteAcceptBaseUrl() {
  return resolvePublicWebOrigin();
}

function buildInviteEmailHtml({ name, role, inviteUrl, welcomeNote }) {
  const note = welcomeNote ? `<p style="color:#666;">${welcomeNote}</p>` : "";
  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="color:#111;">You're invited to IFCDC Barbers</h2>
      <p>Hi ${name},</p>
      <p>You have been invited as <strong>${role}</strong>. Complete onboarding using the link below:</p>
      <p><a href="${inviteUrl}" style="display:inline-block;padding:12px 20px;background:#c9a227;color:#000;text-decoration:none;border-radius:8px;font-weight:700;">Accept invitation</a></p>
      ${note}
      <p style="font-size:12px;color:#888;">If the button does not work, copy this URL:<br/>${inviteUrl}</p>
    </div>
  `;
}

async function sendInviteEmailIfReady({ invite, sendEmail, sendEmailFn }) {
  if (!sendEmail || typeof sendEmailFn !== "function") return false;
  const inviteUrl = buildInviteAcceptUrl(invite.invite_token);
  console.log("[admin/invite] Invite URL Generated:", inviteUrl);
  try {
    const result = await sendEmailFn({
      to: invite.email,
      subject: "You're invited to IFCDC Barbers",
      html: buildInviteEmailHtml({
        name: invite.name,
        role: invite.role,
        inviteUrl,
        welcomeNote: invite.welcome_note,
      }),
    });
    return Boolean(result?.success ?? result?.ok);
  } catch (e) {
    console.warn("[admin/invite] email failed:", e?.message || e);
    return false;
  }
}

function parseInviteToken(req) {
  const fromQuery = typeof req.query?.token === "string" ? req.query.token : "";
  const fromBody = typeof req.body?.token === "string" ? req.body.token : "";
  const token = String(fromQuery || fromBody || "").trim();
  return token;
}

async function loadActiveInviteByToken(token) {
  const r = await dbQuery(
    `SELECT i.*, b.name AS business_name
     FROM pending_user_invites i
     LEFT JOIN businesses b ON b.id = i.business_id
     WHERE i.invite_token = $1
       AND i.status = ANY($2::text[])
     LIMIT 1`,
    [token, ACTIVE_INVITE_STATUSES],
  );
  return r.rows?.[0] || null;
}

export function registerPublicInviteRoutes(router) {
  // Validate an invite token so the frontend can render a safe acceptance UI.
  router.get("/api/invite/validate", async (req, res) => {
    const token = parseInviteToken(req);
    console.log("[invite] validate token:", token ? `${token.slice(0, 6)}…` : "(missing)");
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });
    const row = await loadActiveInviteByToken(token);
    if (!row) return res.status(404).json({ ok: false, error: "invalid_or_expired" });
    const invite = rowToInvite(row);
    // Do not leak internal ids/tokens beyond what’s needed.
    return res.json({
      ok: true,
      invite: {
        email: invite.email,
        name: invite.name,
        role: invite.role,
        businessName: invite.businessName,
        status: invite.status,
      },
    });
  });

  // Accept an invite: create the account with invite role + business scope.
  router.post("/api/invite/accept", async (req, res) => {
    const token = parseInviteToken(req);
    console.log("[invite] accept token:", token ? `${token.slice(0, 6)}…` : "(missing)");
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });

    const password = String(req.body?.password || "").trim();
    if (!password) return res.status(400).json({ ok: false, error: "password_required" });

    const row = await loadActiveInviteByToken(token);
    if (!row) return res.status(404).json({ ok: false, error: "invalid_or_expired" });

    // Lazy imports to avoid circular deps at module-load time.
    const { hashPassword, validatePasswordStrength } = await import("./authPasswordPolicy.js");
    const { issueAppUserJwt } = await import("./authRoutes.js");
    const { publicUserFromAppUser } = await import("./authPlatformJwt.js");

    const pw = validatePasswordStrength(password);
    if (!pw.valid) {
      return res.status(400).json({ ok: false, error: "weak_password", message: pw.message });
    }

    const email = normalizeEmail(row.email);
    const name = String(row.name || "").trim().slice(0, 255) || email.split("@")[0] || "User";
    const role = normalizeInviteRole(row.role);
    const phoneRaw = row.phone != null ? String(row.phone).replace(/\D/g, "").slice(0, 15) : null;
    const businessId = row.business_id != null ? Number(row.business_id) : null;

    // Prevent duplicate acceptance.
    const existingUser = await dbQuery(
      `SELECT id FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
      [email],
    );
    if (existingUser.rows?.length) {
      return res.status(409).json({ ok: false, error: "email_exists", message: "This email is already registered." });
    }

    const passwordHash = await hashPassword(password);
    const created = await dbQuery(
      `INSERT INTO app_users (name, email, phone, password_hash, role, business_id)
       VALUES ($1, $2, $3, $4, $5, $6::bigint)
       RETURNING id, name, email, phone, profile_image_url, role, barber_id, business_id, created_at`,
      [name, email, phoneRaw, passwordHash, role, businessId],
    );
    const user = created.rows?.[0];
    if (!user) return res.status(500).json({ ok: false, error: "create_failed" });

    await dbQuery(
      `UPDATE pending_user_invites
       SET status = 'accepted', onboarding_state = 'invite_accepted'
       WHERE id = $1::uuid`,
      [row.id],
    );

    const tokenJwt = issueAppUserJwt(user);
    return res.json({
      ok: true,
      token: tokenJwt,
      user: publicUserFromAppUser(user),
    });
  });
}

function parseBusinessId(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim();
  if (text.startsWith("placeholder-")) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

async function loadInviteById(inviteId) {
  const r = await dbQuery(
    `SELECT i.*, b.name AS business_name
     FROM pending_user_invites i
     LEFT JOIN businesses b ON b.id = i.business_id
     WHERE i.id = $1::uuid
     LIMIT 1`,
    [String(inviteId)],
  );
  return r.rows?.[0] || null;
}

async function attachBusinessName(row) {
  if (!row?.business_id) return row;
  const bizJoin = await dbQuery(`SELECT name AS business_name FROM businesses WHERE id = $1 LIMIT 1`, [row.business_id]);
  row.business_name = bizJoin.rows?.[0]?.business_name ?? null;
  return row;
}

/** Register invite routes on an existing Express router (same mount as /api/admin/users). */
export function registerAdminInviteRoutes(router, { sendEmail } = {}) {
  router.get("/api/admin/pending-invites", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const params = [];
      let where = ` WHERE i.status = ANY($1::text[]) `;
      params.push(ACTIVE_INVITE_STATUSES);
      if (!scope.all) {
        where += ` AND i.business_id = $2 `;
        params.push(scope.businessId);
      }
      const r = await dbQuery(
        `SELECT i.*, b.name AS business_name
         FROM pending_user_invites i
         LEFT JOIN businesses b ON b.id = i.business_id
         ${where}
         ORDER BY i.created_at DESC
         LIMIT 200`,
        params,
      );
      const invites = (r.rows || []).map(rowToInvite);
      return res.json({ ok: true, success: true, invites });
    } catch (e) {
      console.error("[admin/invite] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to load pending invites" });
    }
  });

  router.post("/api/admin/invite-user", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const body = req.body || {};
      const name = String(body.fullName || body.name || "").trim().slice(0, 255);
      const email = normalizeEmail(body.email);
      const phoneRaw = body.phone != null ? String(body.phone).replace(/\D/g, "").slice(0, 15) : "";
      const phone = phoneRaw || null;
      const role = normalizeInviteRole(body.role);
      const welcomeNote = body.welcomeNote != null ? String(body.welcomeNote).trim().slice(0, 2000) : null;
      const sendEmailFlag = body.sendInvite !== false && body.sendEmail !== false;
      const sendSmsRequested = Boolean(body.sendSms);
      const smsWarning = sendSmsRequested ? SMS_UNAVAILABLE_MESSAGE : null;

      if (!name) return res.status(400).json({ ok: false, success: false, message: "Full name is required." });
      if (!email) return res.status(400).json({ ok: false, success: false, message: "Valid email is required." });

      const roleCheck = validateInviteRole(scope, email, role);
      if (!roleCheck.ok) {
        return res.status(403).json({ ok: false, success: false, message: roleCheck.message });
      }

      const needsShop = role === "barber" || role === "shop_owner";
      const rawBiz = body.businessId ?? body.business_id;
      let businessId = parseBusinessId(rawBiz);
      if (businessId == null && !scope.all && scope.businessId != null) {
        businessId = scope.businessId;
      }

      if (needsShop && businessId == null && !String(rawBiz || "").startsWith("placeholder-")) {
        return res.status(400).json({ ok: false, success: false, message: "A shop is required for this role." });
      }
      if (!scope.all && businessId != null && businessId !== scope.businessId) {
        return res.status(403).json({ ok: false, success: false, message: "You can only invite users to your shop." });
      }
      if (businessId != null) {
        const biz = await dbQuery(`SELECT id FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
        if (!biz.rows?.length) {
          return res.status(400).json({ ok: false, success: false, message: "Shop not found." });
        }
      }

      const existingUser = await dbQuery(
        `SELECT id FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
        [email],
      );
      if (existingUser.rows?.length) {
        return res.status(409).json({ ok: false, success: false, message: "This email is already registered." });
      }

      const existingInvite = await dbQuery(
        `SELECT id FROM pending_user_invites
         WHERE lower(trim(email)) = lower(trim($1))
           AND status = ANY($2::text[])
         LIMIT 1`,
        [email, ACTIVE_INVITE_STATUSES],
      );
      if (existingInvite.rows?.length) {
        return res.status(409).json({ ok: false, success: false, message: "An active invite already exists for this email." });
      }

      const inviteToken = crypto.randomBytes(24).toString("hex");
      const ins = await dbQuery(
        `INSERT INTO pending_user_invites (
           invite_token, email, name, phone, role, business_id, welcome_note,
           status, onboarding_state, send_email, send_sms, invited_by
         ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, 'pending', 'invite_pending', $8, $9, $10::uuid)
         RETURNING *`,
        [
          inviteToken,
          email,
          name,
          phone,
          role,
          businessId,
          welcomeNote,
          sendEmailFlag,
          false,
          scope.actorId || null,
        ],
      );
      let row = ins.rows?.[0];
      if (!row) {
        return res.status(500).json({ ok: false, success: false, message: "Failed to create invite." });
      }

      let emailSent = false;
      if (sendEmailFlag) {
        emailSent = await sendInviteEmailIfReady({ invite: row, sendEmail: true, sendEmailFn: sendEmail });
      }

      const upd = await dbQuery(
        `UPDATE pending_user_invites
         SET status = $2, sent_at = CASE WHEN $3 THEN NOW() ELSE sent_at END,
             onboarding_state = CASE WHEN $3 THEN 'invite_sent' ELSE onboarding_state END
         WHERE id = $1::uuid
         RETURNING *`,
        [row.id, emailSent ? "sent" : "pending", emailSent],
      );
      row = upd.rows?.[0] || row;
      await attachBusinessName(row);

      const invite = rowToInvite(row);
      return res.status(201).json({
        ok: true,
        success: true,
        message: "Invitation created",
        invite,
        inviteToken,
        emailSent,
        smsSent: false,
        smsWarning,
        masterEmail: CANONICAL_SUPER_ADMIN_EMAIL,
      });
    } catch (e) {
      console.error("[admin/invite] create failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to create invite" });
    }
  });

  router.post("/api/admin/resend-invite", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const inviteId = String(req.body?.inviteId || req.body?.id || "").trim();
      if (!inviteId) return res.status(400).json({ ok: false, success: false, message: "inviteId is required." });

      const row = await loadInviteById(inviteId);
      if (!row) return res.status(404).json({ ok: false, success: false, message: "Invite not found." });
      if (!ACTIVE_INVITE_STATUSES.includes(String(row.status))) {
        return res.status(400).json({ ok: false, success: false, message: "This invite can no longer be resent." });
      }
      if (!scope.all) {
        const biz = row.business_id != null ? Number(row.business_id) : NaN;
        if (!Number.isFinite(biz) || biz !== scope.businessId) {
          return res.status(403).json({ ok: false, success: false, message: "You cannot resend this invite." });
        }
      }

      const emailSent = await sendInviteEmailIfReady({
        invite: row,
        sendEmail: Boolean(row.send_email),
        sendEmailFn: sendEmail,
      });
      const smsWarning = Boolean(row.send_sms) ? SMS_UNAVAILABLE_MESSAGE : null;

      const upd = await dbQuery(
        `UPDATE pending_user_invites
         SET status = $2, sent_at = CASE WHEN $3 THEN NOW() ELSE sent_at END,
             onboarding_state = CASE WHEN $3 THEN 'invite_sent' ELSE onboarding_state END
         WHERE id = $1::uuid
         RETURNING *`,
        [inviteId, emailSent ? "sent" : row.status, emailSent],
      );
      const updated = upd.rows?.[0] || row;
      await attachBusinessName(updated);

      return res.json({
        ok: true,
        success: true,
        message: "Invitation created",
        invite: rowToInvite(updated),
        emailSent,
        smsSent: false,
        smsWarning,
      });
    } catch (e) {
      console.error("[admin/invite] resend failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to resend invite" });
    }
  });

  router.delete("/api/admin/cancel-invite", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const inviteId = String(req.body?.inviteId || req.body?.id || req.query?.inviteId || "").trim();
      if (!inviteId) return res.status(400).json({ ok: false, success: false, message: "inviteId is required." });

      const row = await loadInviteById(inviteId);
      if (!row) return res.status(404).json({ ok: false, success: false, message: "Invite not found." });
      if (!scope.all) {
        const biz = row.business_id != null ? Number(row.business_id) : NaN;
        if (!Number.isFinite(biz) || biz !== scope.businessId) {
          return res.status(403).json({ ok: false, success: false, message: "You cannot revoke this invite." });
        }
      }

      await dbQuery(
        `UPDATE pending_user_invites
         SET status = 'revoked', revoked_at = NOW(), onboarding_state = 'invite_revoked'
         WHERE id = $1::uuid`,
        [inviteId],
      );

      return res.json({ ok: true, success: true, inviteId });
    } catch (e) {
      console.error("[admin/invite] cancel failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to revoke invite" });
    }
  });

  // Hard delete (remove old / accidental / expired invites).
  router.delete("/api/admin/delete-invite", async (req, res) => {
    const scope = await resolveUserManagementScope(req, res);
    if (!scope) return;

    try {
      const inviteId = String(req.body?.inviteId || req.body?.id || req.query?.inviteId || "").trim();
      if (!inviteId) return res.status(400).json({ ok: false, success: false, message: "inviteId is required." });

      const row = await loadInviteById(inviteId);
      if (!row) return res.status(404).json({ ok: false, success: false, message: "Invite not found." });
      if (!scope.all) {
        const biz = row.business_id != null ? Number(row.business_id) : NaN;
        if (!Number.isFinite(biz) || biz !== scope.businessId) {
          return res.status(403).json({ ok: false, success: false, message: "You cannot delete this invite." });
        }
      }

      await dbQuery(`DELETE FROM pending_user_invites WHERE id = $1::uuid`, [inviteId]);
      return res.json({ ok: true, success: true, inviteId });
    } catch (e) {
      console.error("[admin/invite] delete failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to delete invite" });
    }
  });
}

export function createAdminInviteRouter({ sendEmail } = {}) {
  const router = express.Router();
  registerAdminInviteRoutes(router, { sendEmail });
  return router;
}
