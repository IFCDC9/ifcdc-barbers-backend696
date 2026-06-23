/**
 * Global barber roster for super admin / shop-scoped owners.
 */
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";

const require = createRequire(import.meta.url);
const pushNotifier = require("./pushNotifier.cjs");

export function parseLocationFields(locationRaw, businessCity, businessState) {
  let city = String(businessCity || "").trim();
  let state = String(businessState || "").trim();
  if (city && state) return { city, state };

  try {
    const j =
      typeof locationRaw === "string" && locationRaw.trim().startsWith("{")
        ? JSON.parse(locationRaw)
        : typeof locationRaw === "object" && locationRaw
          ? locationRaw
          : null;
    const addr = String(j?.address || locationRaw || "").trim();
    if (addr && !city) {
      const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const maybeState = parts[parts.length - 1];
        const maybeCity = parts[parts.length - 2];
        if (/^[A-Za-z]{2}$/.test(maybeState) || maybeState.length <= 20) {
          state = state || maybeState;
          city = city || maybeCity;
        }
      }
    }
    if (j?.city) city = city || String(j.city).trim();
    if (j?.state) state = state || String(j.state).trim();
  } catch {
    /* ignore */
  }
  return { city: city || null, state: state || null };
}

function computeAccountStatus(accountStatus, verificationStatus) {
  const acct = String(accountStatus || "active").toLowerCase();
  const verify = String(verificationStatus || "pending").toLowerCase();
  if (acct === "disabled" || acct === "suspended") return "Suspended";
  if (verify === "pending" || acct === "pending") return "Pending";
  if (verify === "rejected") return "Suspended";
  return "Approved";
}

function rowToAdminBarber(row) {
  const loc = parseLocationFields(row.location, row.business_city, row.business_state);
  const verificationStatus = String(row.verification_status || "pending").toLowerCase();
  const accountStatus = computeAccountStatus(row.account_status, verificationStatus);
  const subscriptionTier = String(row.subscription_tier || row.business_plan || "free").toLowerCase();
  const subscriptionStatus = String(row.business_subscription_status || row.subscription_tier || "inactive").toLowerCase();
  const isActive = accountStatus === "Approved" && String(row.account_status || "").toLowerCase() !== "disabled";

  return {
    id: String(row.barber_id),
    barberId: Number(row.barber_id),
    userId: row.user_id ? String(row.user_id) : null,
    fullName: row.full_name || row.barber_name || "—",
    shopName: row.shop_name || row.business_name || "—",
    city: loc.city,
    state: loc.state,
    locationLabel: [loc.city, loc.state].filter(Boolean).join(", ") || row.location_text || "—",
    email: row.email || "—",
    phone: row.phone || row.barber_phone || row.business_phone || null,
    registrationDate: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    accountStatus,
    subscriptionStatus: subscriptionStatus === "active" || subscriptionTier === "pro" || subscriptionTier === "elite"
      ? subscriptionTier === "elite"
        ? "Elite"
        : subscriptionTier === "pro"
          ? "Pro"
          : "Active"
      : subscriptionStatus === "inactive"
        ? "Inactive"
        : subscriptionStatus.charAt(0).toUpperCase() + subscriptionStatus.slice(1),
    verificationStatus: verificationStatus.charAt(0).toUpperCase() + verificationStatus.slice(1),
    isActive,
    pendingApproval: verificationStatus === "pending",
    businessId: row.business_id != null ? Number(row.business_id) : null,
  };
}

/**
 * @param {{ all: boolean, businessId?: number }} scope
 * @param {Record<string, string>} filters
 */
export async function listAdminBarbers(scope, filters = {}) {
  const params = [];
  const where = ["1=1"];

  if (!scope.all) {
    params.push(Number(scope.businessId));
    where.push(`b.business_id = $${params.length}::bigint`);
  }

  const shop = String(filters.shop || "").trim();
  if (shop) {
    params.push(`%${shop.toLowerCase()}%`);
    where.push(
      `(lower(coalesce(b.shop_name, '')) LIKE $${params.length} OR lower(coalesce(biz.name, '')) LIKE $${params.length})`,
    );
  }

  const city = String(filters.city || "").trim();
  if (city) {
    params.push(`%${city.toLowerCase()}%`);
    where.push(
      `(lower(coalesce(biz.city, '')) LIKE $${params.length} OR lower(coalesce(b.location, '')) LIKE $${params.length})`,
    );
  }

  const state = String(filters.state || "").trim();
  if (state) {
    params.push(`%${state.toLowerCase()}%`);
    where.push(
      `(lower(coalesce(biz.state, '')) LIKE $${params.length} OR lower(coalesce(b.location, '')) LIKE $${params.length})`,
    );
  }

  if (String(filters.pendingApproval || "").toLowerCase() === "true") {
    where.push(`lower(coalesce(b.verification_status, 'pending')) = 'pending'`);
  }

  const activeFilter = String(filters.active || filters.activeInactive || "").toLowerCase();
  if (activeFilter === "active") {
    where.push(`lower(coalesce(u.account_status, 'active')) = 'active'`);
    where.push(`lower(coalesce(b.verification_status, 'pending')) = 'approved'`);
  } else if (activeFilter === "inactive") {
    where.push(
      `(lower(coalesce(u.account_status, 'active')) IN ('disabled', 'suspended') OR lower(coalesce(b.verification_status, 'pending')) IN ('pending', 'rejected'))`,
    );
  }

  let orderBy = "COALESCE(b.created_at, u.created_at) DESC NULLS LAST";
  const sort = String(filters.sort || filters.registrationDate || "").toLowerCase();
  if (sort === "asc" || sort === "oldest") {
    orderBy = "COALESCE(b.created_at, u.created_at) ASC NULLS LAST";
  } else if (sort === "name") {
    orderBy = "COALESCE(b.name, u.name) ASC NULLS LAST";
  } else if (sort === "shop") {
    orderBy = "COALESCE(b.shop_name, biz.name) ASC NULLS LAST";
  }

  const sql = `
    SELECT
      b.id AS barber_id,
      b.name AS barber_name,
      b.shop_name,
      b.phone AS barber_phone,
      b.location,
      b.verification_status,
      b.business_id,
      b.created_at AS barber_created_at,
      u.id AS user_id,
      u.name AS full_name,
      u.email,
      u.phone,
      u.account_status,
      u.created_at AS user_created_at,
      biz.name AS business_name,
      biz.phone AS business_phone,
      biz.city AS business_city,
      biz.state AS business_state,
      biz.plan AS business_plan,
      biz.subscription_status AS business_subscription_status,
      bs.subscription_tier,
      COALESCE(b.created_at, u.created_at) AS registered_at,
      CASE
        WHEN b.location IS NOT NULL AND b.location NOT LIKE '{%' THEN b.location
        ELSE NULL
      END AS location_text
    FROM barbers b
    LEFT JOIN app_users u ON u.id = b.user_id
    LEFT JOIN businesses biz ON biz.id = b.business_id
    LEFT JOIN barber_settings bs ON bs.barber_id = b.id
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT 1000
  `;

  const r = await dbQuery(sql, params);
  return (r.rows || []).map(rowToAdminBarber);
}

export async function persistBusinessLocation(businessId, address, city, state) {
  const loc = parseLocationFields(address, city, state);
  if (!Number.isFinite(Number(businessId))) return loc;
  if (!loc.city && !loc.state) return loc;
  await dbQuery(`UPDATE businesses SET city = COALESCE($2, city), state = COALESCE($3, state) WHERE id = $1`, [
    Number(businessId),
    loc.city,
    loc.state,
  ]).catch(() => {});
  return loc;
}

export async function resolveSuperAdminUserIds() {
  const r = await dbQuery(`SELECT id FROM app_users WHERE role = 'super_admin'`);
  return (r.rows || []).map((row) => String(row.id)).filter(Boolean);
}

export async function notifySuperAdminsNewBarber({ barberId, fullName, shopName, city, state, email }) {
  const title = "New barber registered";
  const location = [city, state].filter(Boolean).join(", ");
  const body = `${fullName || "A barber"} joined${shopName ? ` at ${shopName}` : ""}${location ? ` (${location})` : ""}.`;

  const adminIds = await resolveSuperAdminUserIds();
  if (!adminIds.length) return { ok: true, notified: 0 };

  const payload = { barberId: Number(barberId), email: email || null, shopName: shopName || null };

  for (const userId of adminIds) {
    await dbQuery(
      `INSERT INTO admin_user_notifications (user_id, kind, title, body, payload)
       VALUES ($1::uuid, 'barber_registered', $2, $3, $4::jsonb)`,
      [userId, title, body, JSON.stringify(payload)],
    ).catch(() => {});
  }

  void pushNotifier.sendPushToUsers({
    dbQuery,
    userIds: adminIds,
    kind: "admin_alert",
    title,
    body,
    data: { barberId: String(barberId), type: "barber_registered" },
  }).catch(() => {});

  return { ok: true, notified: adminIds.length };
}

export async function listAdminNotifications(userId, { unreadOnly = false } = {}) {
  const params = [String(userId)];
  let sql = `
    SELECT id, kind, title, body, payload, read_at, created_at
    FROM admin_user_notifications
    WHERE user_id = $1::uuid
  `;
  if (unreadOnly) sql += ` AND read_at IS NULL`;
  sql += ` ORDER BY created_at DESC LIMIT 100`;
  const r = await dbQuery(sql, params);
  return (r.rows || []).map((row) => ({
    id: String(row.id),
    kind: row.kind,
    title: row.title,
    body: row.body,
    payload: row.payload || null,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}
