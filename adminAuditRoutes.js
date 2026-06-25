import { dbQuery } from "./db.js";
import { resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { adminActivityLabel } from "./adminActivityLog.js";

const SECURITY_EVENT_TYPES = new Set([
  "login_failed",
  "login_success",
  "password_reset",
  "password_reset_request",
  "account_suspended",
  "role_change",
  "invite_sent",
  "admin_change",
  "suspicious_activity",
]);

const PAYMENT_EVENT_TYPES = new Set([
  "payment_capture",
  "payment_refund",
  "payment_override",
  "platform_fee",
]);

const BOOKING_EVENT_TYPES = new Set([
  "booking_override",
  "booking_cancel_admin",
  "booking_create_admin",
  "booking_deleted",
]);

const CONTENT_EVENT_TYPES = new Set(["message_deleted", "notification_deleted", "media_deleted"]);

const ONBOARDING_ACTIVITY_TYPES = [
  "signup_received",
  "barber_approved",
  "shop_owner_approved",
  "account_denied",
  "account_suspended",
  "account_deleted",
  "role_changed",
];

const USER_EVENT_TYPES = new Set([
  "invite_sent",
  "invite_revoked",
  "role_change",
  "role_changed",
  "account_suspended",
  "account_reactivated",
  "user_created",
  "signup_received",
  "barber_approved",
  "shop_owner_approved",
  "account_denied",
  "account_deleted",
]);

const ADMIN_EVENT_TYPES = new Set(["admin_change", "role_change", "invite_sent", "settings_change"]);

function formatAction(eventType) {
  const map = {
    login_success: "User login",
    login_failed: "Failed login attempt",
    role_change: "Role changed",
    password_reset: "Password reset",
    password_reset_request: "Password reset requested",
    invite_sent: "Invitation sent",
    invite_revoked: "Invitation revoked",
    account_suspended: "Account suspended",
    account_reactivated: "Account reactivated",
    booking_override: "Booking override",
    payment_capture: "Payment captured",
    payment_refund: "Payment refunded",
    payment_override: "Payment action",
    platform_fee: "Platform fee recorded",
    admin_change: "Admin settings changed",
    suspicious_activity: "Suspicious activity flagged",
    user_created: "User account created",
    signup_received: "New signup received",
    barber_approved: "Barber approved",
    shop_owner_approved: "Shop owner approved",
    account_denied: "Account denied",
    account_deleted: "Account deleted",
    role_changed: "Role changed",
    booking_cancel_admin: "Booking cancelled by admin",
    booking_create_admin: "Booking created by admin",
    booking_deleted: "Booking deleted",
    message_deleted: "AURA message deleted",
    notification_deleted: "Notification removed",
    media_deleted: "Media deleted",
  };
  return map[eventType] || String(eventType || "Platform event").replace(/_/g, " ");
}

function categorizeEvent(eventType) {
  const t = String(eventType || "").toLowerCase();
  if (SECURITY_EVENT_TYPES.has(t) && (t.includes("login") || t.includes("password") || t.includes("suspicious"))) {
    return "security";
  }
  if (PAYMENT_EVENT_TYPES.has(t)) return "payments";
  if (BOOKING_EVENT_TYPES.has(t)) return "bookings";
  if (CONTENT_EVENT_TYPES.has(t)) return "admin";
  if (USER_EVENT_TYPES.has(t)) return "users";
  if (ADMIN_EVENT_TYPES.has(t)) return "admin";
  if (t.includes("payment")) return "payments";
  if (t.includes("booking")) return "bookings";
  if (t.includes("login") || t.includes("password")) return "security";
  return "admin";
}

function riskForEvent(eventType) {
  const t = String(eventType || "").toLowerCase();
  if (["login_failed", "suspicious_activity", "account_suspended", "payment_override"].includes(t)) {
    return "critical";
  }
  if (["role_change", "password_reset", "password_reset_request", "admin_change", "booking_override"].includes(t)) {
    return "warning";
  }
  return "normal";
}

function simplifyDevice(ua) {
  const raw = String(ua || "").trim();
  if (!raw) return "Unknown device";
  if (/iPhone|iPad|iOS/i.test(raw)) return "iOS device";
  if (/Android/i.test(raw)) return "Android device";
  if (/Macintosh|Mac OS/i.test(raw)) return "macOS";
  if (/Windows/i.test(raw)) return "Windows";
  if (/Expo|ReactNative/i.test(raw)) return "IFCDC mobile app";
  return raw.length > 42 ? `${raw.slice(0, 42)}…` : raw;
}

function rowToAuditEvent(row) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const eventType = String(row.event_type || "unknown");
  const targetEmail = meta.userEmail || meta.targetEmail || null;
  return {
    id: String(row.id),
    user: String(meta.userName || meta.name || row.actor_email || "Platform user"),
    email: row.actor_email || null,
    targetUserEmail: targetEmail,
    role: String(meta.role || meta.targetRole || "—"),
    action: meta.actionPerformed || adminActivityLabel(eventType) || formatAction(eventType),
    actionKey: eventType,
    category: categorizeEvent(eventType),
    timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
    ip: row.ip_text || "—",
    device: simplifyDevice(row.user_agent),
    riskLevel: riskForEvent(eventType),
    detail: meta.detail || meta.message || meta.summary || null,
  };
}

async function resolveAuditScope(req, res) {
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
  if (!isJwtGlobalSuperScope(payload)) {
    res.status(403).json({ ok: false, message: "Audit access is restricted to super admins." });
    return null;
  }
  return payload;
}

function parseDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30) return n;
  return 7;
}

async function loadAuditSummary() {
  const [admins, failed, invites, shops, suspicious] = await Promise.all([
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM app_users
       WHERE lower(role) IN ('admin','super_admin') AND lower(coalesce(account_status,'active')) = 'active'`,
    ),
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM security_audit_log
       WHERE event_type = 'login_failed' AND created_at >= NOW() - INTERVAL '7 days'`,
    ),
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM pending_user_invites
       WHERE status IN ('pending','sent')`,
    ).catch(() => ({ rows: [{ c: 0 }] })),
    dbQuery(`SELECT COUNT(*)::int AS c FROM businesses`).catch(() => ({ rows: [{ c: 0 }] })),
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM security_audit_log
       WHERE event_type IN ('login_failed','suspicious_activity','account_suspended')
         AND created_at >= NOW() - INTERVAL '7 days'`,
    ),
  ]);

  return {
    activeAdmins: admins.rows?.[0]?.c ?? 0,
    failedLogins: failed.rows?.[0]?.c ?? 0,
    pendingInvites: invites.rows?.[0]?.c ?? 0,
    suspiciousActivity: suspicious.rows?.[0]?.c ?? 0,
    activeShops: shops.rows?.[0]?.c ?? 0,
  };
}

async function queryAuditEvents({ days, category, securityOnly }) {
  const params = [];
  let where = ` WHERE created_at >= NOW() - ($1::int || ' days')::interval `;
  params.push(String(days));

  if (securityOnly) {
    where += ` AND event_type = ANY($2::text[]) `;
    params.push([
      "login_failed",
      "login_success",
      "password_reset",
      "password_reset_request",
      "account_suspended",
      "suspicious_activity",
      "role_change",
    ]);
  }

  const r = await dbQuery(
    `SELECT id, created_at, event_type, actor_user_id, actor_email, ip_text, user_agent, metadata
     FROM security_audit_log
     ${where}
     ORDER BY created_at DESC
     LIMIT 300`,
    params,
  );

  let events = (r.rows || []).map(rowToAuditEvent);
  if (category && category !== "all") {
    events = events.filter((e) => e.category === category);
  }
  return events;
}

/** Register audit routes on the admin users router. */
export function registerAdminAuditRoutes(router) {
  router.get("/api/admin/activity-log", async (req, res) => {
    const scope = await resolveAuditScope(req, res);
    if (!scope) return;

    try {
      const days = parseDays(req.query?.days);
      const r = await dbQuery(
        `SELECT id, created_at, event_type, actor_user_id, actor_email, ip_text, user_agent, metadata
         FROM security_audit_log
         WHERE created_at >= NOW() - ($1::int || ' days')::interval
           AND event_type = ANY($2::text[])
         ORDER BY created_at DESC
         LIMIT 200`,
        [String(days), ONBOARDING_ACTIVITY_TYPES],
      );
      const entries = (r.rows || []).map((row) => {
        const event = rowToAuditEvent(row);
        return {
          id: event.id,
          timestamp: event.timestamp,
          adminEmail: event.email,
          userEmail: event.targetUserEmail,
          action: event.action,
          actionKey: event.actionKey,
          detail: event.detail,
        };
      });
      return res.json({ ok: true, success: true, entries, days });
    } catch (e) {
      console.error("[admin/activity-log] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to load activity log" });
    }
  });

  router.get("/api/admin/audit-logs", async (req, res) => {
    const scope = await resolveAuditScope(req, res);
    if (!scope) return;

    try {
      const days = parseDays(req.query?.days);
      const category = String(req.query?.category || "all").trim().toLowerCase();
      const [summary, events] = await Promise.all([
        loadAuditSummary(),
        queryAuditEvents({ days, category, securityOnly: false }),
      ]);

      return res.json({
        ok: true,
        success: true,
        summary,
        events,
        days,
        category,
      });
    } catch (e) {
      console.error("[admin/audit] list failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to load audit logs" });
    }
  });

  router.get("/api/admin/security-events", async (req, res) => {
    const scope = await resolveAuditScope(req, res);
    if (!scope) return;

    try {
      const days = parseDays(req.query?.days);
      const events = await queryAuditEvents({ days, category: "security", securityOnly: true });
      const critical = events.filter((e) => e.riskLevel === "critical").length;
      const warning = events.filter((e) => e.riskLevel === "warning").length;

      return res.json({
        ok: true,
        success: true,
        events,
        totals: { critical, warning, count: events.length },
        days,
      });
    } catch (e) {
      console.error("[admin/audit] security-events failed:", e?.message || e);
      return res.status(500).json({ ok: false, success: false, message: "Failed to load security events" });
    }
  });
}
