/**
 * Permanent admin activity audit trail (security_audit_log).
 * Each entry: timestamp, admin email, user email, action performed.
 */
import { dbQuery } from "./db.js";
import { writeSecurityAudit } from "./auditSecurity.js";

export const ADMIN_ACTIVITY = {
  SIGNUP_RECEIVED: "signup_received",
  BARBER_APPROVED: "barber_approved",
  SHOP_OWNER_APPROVED: "shop_owner_approved",
  ACCOUNT_DENIED: "account_denied",
  ACCOUNT_SUSPENDED: "account_suspended",
  ACCOUNT_DELETED: "account_deleted",
  BARBER_BOOKING_HIDDEN: "barber_booking_hidden",
  BARBER_BOOKING_VISIBLE: "barber_booking_visible",
  ROLE_CHANGED: "role_changed",
};

const ACTION_LABELS = {
  [ADMIN_ACTIVITY.SIGNUP_RECEIVED]: "New signup received",
  [ADMIN_ACTIVITY.BARBER_APPROVED]: "Barber approved",
  [ADMIN_ACTIVITY.SHOP_OWNER_APPROVED]: "Shop owner approved",
  [ADMIN_ACTIVITY.ACCOUNT_DENIED]: "Account denied",
  [ADMIN_ACTIVITY.ACCOUNT_SUSPENDED]: "Account suspended",
  [ADMIN_ACTIVITY.ACCOUNT_DELETED]: "Account deleted",
  [ADMIN_ACTIVITY.BARBER_BOOKING_HIDDEN]: "Barber hidden from bookings",
  [ADMIN_ACTIVITY.BARBER_BOOKING_VISIBLE]: "Barber shown on bookings",
  [ADMIN_ACTIVITY.ROLE_CHANGED]: "Role changed",
};

export function adminActivityLabel(eventType) {
  return ACTION_LABELS[eventType] || String(eventType || "Admin action").replace(/_/g, " ");
}

export async function resolveAdminEmail(actorUserId) {
  if (!actorUserId) return null;
  const r = await dbQuery(`SELECT email FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(actorUserId)]);
  return r.rows?.[0]?.email ? String(r.rows[0].email).trim() : null;
}

/**
 * @param {{
 *   eventType: string,
 *   adminUserId?: string|null,
 *   adminEmail?: string|null,
 *   userEmail?: string|null,
 *   userName?: string|null,
 *   detail?: string|null,
 *   metadata?: Record<string, unknown>,
 *   req?: import("express").Request,
 * }} p
 */
export async function logAdminActivity(p) {
  const eventType = String(p?.eventType || "admin_action");
  const adminEmail =
    (p?.adminEmail && String(p.adminEmail).trim()) ||
    (await resolveAdminEmail(p?.adminUserId)) ||
    "system";
  const userEmail = p?.userEmail ? String(p.userEmail).trim() : null;
  const action = adminActivityLabel(eventType);

  await writeSecurityAudit({
    eventType,
    actorUserId: p?.adminUserId || null,
    actorEmail: adminEmail,
    req: p?.req,
    metadata: {
      ...(p?.metadata || {}),
      userEmail,
      userName: p?.userName || null,
      action,
      actionPerformed: action,
      detail: p?.detail || null,
    },
  });

  return { ok: true, eventType, adminEmail, userEmail, action };
}
