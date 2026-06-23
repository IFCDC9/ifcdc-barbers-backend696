/**
 * Global barber roster for super admin / shop-scoped owners.
 */
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";

const require = createRequire(import.meta.url);
const pushNotifier = require("./pushNotifier.cjs");

/** `barbers.business_id` is TEXT in some DBs (e.g. legacy `default`); `businesses.id` is BIGINT. */
export function barberBusinessIdSql(alias = "b") {
  return `CASE
    WHEN ${alias}.business_id IS NOT NULL AND btrim(${alias}.business_id) ~ '^[0-9]+$' THEN btrim(${alias}.business_id)::bigint
    ELSE NULL
  END`;
}

const BARBER_BUSINESS_ID_SQL = barberBusinessIdSql("b");
const BARBER_BUSINESS_JOIN = `biz.id = ${BARBER_BUSINESS_ID_SQL}`;

const BARBER_PROFILE_JOIN = `(
  b.id::text = bp.id::text
  OR (
    b.name IS NOT NULL
    AND btrim(b.name) <> ''
    AND lower(trim(b.name)) = lower(trim(bp.name))
  )
)`;

function normalizeBarberId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return s;
}

function formatDisplayEmail(email) {
  const v = String(email || "").trim();
  return v || "Not linked";
}

function resolveShopName(row) {
  const rawBiz = String(row.business_id || "").trim();
  return (
    String(row.shop_name || "").trim() ||
    String(row.business_name || "").trim() ||
    (rawBiz === "default" ? "IFCDC Barbers" : "") ||
    "Unassigned"
  );
}

function resolveLocationLabel(row, loc) {
  const profileAddr = String(row.profile_address || "").trim();
  const fromParts = [loc.city, loc.state].filter(Boolean).join(", ");
  if (fromParts) return fromParts;
  if (profileAddr) return profileAddr;
  if (row.location_text) return String(row.location_text);
  try {
    if (typeof row.location === "string" && row.location.trim().startsWith("{")) {
      const j = JSON.parse(row.location);
      const addr = String(j?.address || "").trim();
      if (addr) return addr;
      const cityState = [j?.city, j?.state].filter(Boolean).join(", ");
      if (cityState) return cityState;
    }
  } catch {
    /* ignore */
  }
  return "—";
}

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
  const loc = parseLocationFields(
    row.location || row.profile_address,
    row.business_city,
    row.business_state,
  );
  const verificationStatus = String(row.verification_status || "pending").toLowerCase();
  const accountStatus = computeAccountStatus(row.account_status, verificationStatus);
  const subscriptionTier = String(row.subscription_tier || row.business_plan || "free").toLowerCase();
  const subscriptionStatus = String(row.business_subscription_status || row.subscription_tier || "inactive").toLowerCase();
  const isActive = accountStatus === "Approved" && String(row.account_status || "").toLowerCase() !== "disabled";
  const barberId = String(row.barber_id);
  const registeredAt =
    row.registered_at || row.profile_created_at || row.barber_created_at || row.user_created_at || null;

  return {
    id: barberId,
    barberId,
    userId: row.user_id ? String(row.user_id) : null,
    fullName: row.full_name || row.barber_name || "—",
    shopName: resolveShopName(row),
    city: loc.city,
    state: loc.state,
    locationLabel: resolveLocationLabel(row, loc),
    email: formatDisplayEmail(row.email || row.profile_email),
    phone: row.phone || row.barber_phone || row.profile_phone || row.business_phone || null,
    registrationDate: registeredAt ? new Date(registeredAt).toISOString() : null,
    accountStatus,
    subscriptionStatus:
      subscriptionStatus === "active" || subscriptionTier === "pro" || subscriptionTier === "elite"
        ? subscriptionTier === "elite"
          ? "Elite"
          : subscriptionTier === "pro"
            ? "Pro"
            : "Active"
        : subscriptionStatus === "inactive"
          ? "Inactive"
          : subscriptionStatus.charAt(0).toUpperCase() + subscriptionStatus.slice(1),
    subscriptionTier,
    verificationStatus: verificationStatus.charAt(0).toUpperCase() + verificationStatus.slice(1),
    isActive,
    pendingApproval: verificationStatus === "pending",
    businessId:
      row.business_id != null && /^[0-9]+$/.test(String(row.business_id).trim())
        ? Number(row.business_id)
        : null,
    hasUserAccount: Boolean(row.user_id),
  };
}

const ADMIN_BARBER_SELECT = `
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
    bp.contact_email AS profile_email,
    bp.contact_phone AS profile_phone,
    bp.address AS profile_address,
    bp.created_at AS profile_created_at,
    COALESCE(b.created_at, u.created_at, bp.created_at) AS registered_at,
    CASE
      WHEN b.location IS NOT NULL AND b.location NOT LIKE '{%' THEN b.location
      ELSE NULL
    END AS location_text
  FROM barbers b
  LEFT JOIN app_users u ON u.id = b.user_id
  LEFT JOIN businesses biz ON ${BARBER_BUSINESS_JOIN}
  LEFT JOIN barber_settings bs ON bs.barber_id::text = b.id::text
  LEFT JOIN barber_profiles bp ON ${BARBER_PROFILE_JOIN}
`;

/**
 * @param {{ all: boolean, businessId?: number }} scope
 * @param {Record<string, string>} filters
 */
export async function listAdminBarbers(scope, filters = {}) {
  const params = [];
  const where = ["1=1"];

  if (!scope.all) {
    params.push(Number(scope.businessId));
    where.push(`${BARBER_BUSINESS_ID_SQL} = $${params.length}::bigint`);
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
    ${ADMIN_BARBER_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT 1000
  `;

  const r = await dbQuery(sql, params);
  return (r.rows || []).map(rowToAdminBarber);
}

export async function getAdminBarberById(scope, barberIdRaw) {
  const barberId = normalizeBarberId(barberIdRaw);
  if (!barberId) return null;

  const params = [barberId];
  const where = ["b.id::text = $1::text"];
  if (!scope.all) {
    params.push(Number(scope.businessId));
    where.push(`${BARBER_BUSINESS_ID_SQL} = $${params.length}::bigint`);
  }

  const r = await dbQuery(
    `${ADMIN_BARBER_SELECT}
     WHERE ${where.join(" AND ")}
     LIMIT 1`,
    params,
  );
  const row = r.rows?.[0];
  return row ? rowToAdminBarber(row) : null;
}

async function loadBarberScopeRow(barberIdRaw) {
  const barberId = normalizeBarberId(barberIdRaw);
  if (!barberId) return null;
  const r = await dbQuery(
    `SELECT id, user_id, business_id, name, shop_name, verification_status
     FROM barbers WHERE id::text = $1::text LIMIT 1`,
    [barberId],
  );
  return r.rows?.[0] || null;
}

function barberBusinessIdNumber(raw) {
  const text = String(raw ?? "").trim();
  return text && /^[0-9]+$/.test(text) ? Number(text) : NaN;
}

export function assertBarberInScope(scope, row) {
  if (!row) return { ok: false, message: "Barber not found" };
  if (scope.all) return { ok: true };
  const biz = barberBusinessIdNumber(row.business_id);
  if (!Number.isFinite(biz) || biz !== Number(scope.businessId)) {
    return { ok: false, message: "You cannot manage this barber." };
  }
  return { ok: true };
}

export async function updateBarberVerification(barberIdRaw, status) {
  const barberId = normalizeBarberId(barberIdRaw);
  const normalized = String(status || "").trim().toLowerCase();
  if (!barberId || !["pending", "approved", "rejected"].includes(normalized)) {
    return { ok: false, message: "Invalid barber id or verification status." };
  }
  const r = await dbQuery(`UPDATE barbers SET verification_status = $1 WHERE id::text = $2::text RETURNING id`, [
    normalized,
    barberId,
  ]);
  if (!r.rows?.length) return { ok: false, message: "Barber not found" };
  return { ok: true, barberId, verificationStatus: normalized };
}

export async function updateBarberAccountStatus(barberIdRaw, status, { autoApproveVerification = false } = {}) {
  const barberId = normalizeBarberId(barberIdRaw);
  const mapped =
    status === "suspended" || status === "disabled"
      ? "disabled"
      : status === "pending"
        ? "pending"
        : status === "approved" || status === "active"
          ? "active"
          : "";
  if (!barberId || !mapped) return { ok: false, message: "Invalid barber id or account status." };

  const row = await loadBarberScopeRow(barberId);
  if (!row) return { ok: false, message: "Barber not found" };
  if (!row.user_id) {
    if (mapped === "active" || mapped === "approved") {
      await updateBarberVerification(barberId, "approved");
      return { ok: true, barberId, accountStatus: "active", verificationOnly: true };
    }
    return { ok: false, message: "Barber is not linked to a user account." };
  }

  await dbQuery(`UPDATE app_users SET account_status = $1 WHERE id = $2::uuid`, [mapped, row.user_id]);
  if ((mapped === "active" || mapped === "approved") && autoApproveVerification) {
    await dbQuery(`UPDATE barbers SET verification_status = 'approved' WHERE id::text = $1::text`, [barberId]);
  }
  return { ok: true, barberId, accountStatus: mapped };
}

export async function updateAdminBarberProfile(barberIdRaw, fields = {}) {
  const barberId = normalizeBarberId(barberIdRaw);
  if (!barberId) return { ok: false, message: "Invalid barber id." };
  const row = await loadBarberScopeRow(barberId);
  if (!row) return { ok: false, message: "Barber not found" };

  const name = fields.name != null ? String(fields.name).trim() : null;
  const shopName = fields.shopName != null ? String(fields.shopName).trim() : null;
  const phone = fields.phone != null ? String(fields.phone).trim() : null;
  const location = fields.location != null ? String(fields.location).trim() : null;
  const email = fields.email != null ? String(fields.email).trim().toLowerCase() : null;

  const sets = [];
  const params = [barberId];
  let i = 2;
  if (name) {
    sets.push(`name = $${i++}`);
    params.push(name);
  }
  if (shopName !== null) {
    sets.push(`shop_name = $${i++}`);
    params.push(shopName || null);
  }
  if (phone !== null) {
    sets.push(`phone = $${i++}`);
    params.push(phone || null);
  }
  if (location !== null) {
    sets.push(`location = $${i++}`);
    params.push(location || null);
  }
  if (sets.length) {
    await dbQuery(`UPDATE barbers SET ${sets.join(", ")} WHERE id::text = $1::text`, params);
  }

  if (email && row.user_id) {
    await dbQuery(`UPDATE app_users SET email = $1 WHERE id = $2::uuid`, [email, row.user_id]);
  } else if (email) {
    await dbQuery(
      `UPDATE barber_profiles SET contact_email = $1
       WHERE id::text = $2::text OR lower(trim(name)) = lower(trim($3))`,
      [email, barberId, row.name || name || ""],
    ).catch(() => {});
  }

  return { ok: true, barberId };
}

export async function assignBarberToShop(barberIdRaw, businessId, shopName) {
  const barberId = normalizeBarberId(barberIdRaw);
  const bid = Number(businessId);
  if (!barberId || !Number.isFinite(bid)) {
    return { ok: false, message: "Invalid barber or shop id." };
  }
  const biz = await dbQuery(`SELECT id, name FROM businesses WHERE id = $1::bigint LIMIT 1`, [bid]);
  if (!biz.rows?.length) return { ok: false, message: "Shop not found." };
  const resolvedShopName = String(shopName || biz.rows[0].name || "").trim();
  await dbQuery(
    `UPDATE barbers SET business_id = $2, shop_name = $3 WHERE id::text = $1::text`,
    [barberId, String(bid), resolvedShopName || null],
  );
  return { ok: true, barberId, businessId: bid, shopName: resolvedShopName || biz.rows[0].name };
}

export async function updateBarberSubscriptionTier(barberIdRaw, tier) {
  const barberId = normalizeBarberId(barberIdRaw);
  const normalized = String(tier || "free").trim().toLowerCase();
  if (!barberId || !["free", "pro", "elite"].includes(normalized)) {
    return { ok: false, message: "Invalid subscription tier." };
  }
  const existing = await dbQuery(`SELECT 1 FROM barber_settings WHERE barber_id::text = $1::text LIMIT 1`, [barberId]);
  if (existing.rows?.length) {
    await dbQuery(`UPDATE barber_settings SET subscription_tier = $2 WHERE barber_id::text = $1::text`, [
      barberId,
      normalized,
    ]);
  } else {
    await dbQuery(`INSERT INTO barber_settings (barber_id, subscription_tier) VALUES ($1::uuid, $2)`, [
      barberId,
      normalized,
    ]).catch(async () => {
      await dbQuery(`INSERT INTO barber_settings (barber_id, subscription_tier) VALUES ($1, $2)`, [
        barberId,
        normalized,
      ]);
    });
  }
  return { ok: true, barberId, subscriptionTier: normalized };
}

export async function deleteAdminBarber(barberIdRaw) {
  const barberId = normalizeBarberId(barberIdRaw);
  if (!barberId) return { ok: false, message: "Invalid barber id." };
  const row = await loadBarberScopeRow(barberId);
  if (!row) return { ok: false, message: "Barber not found" };

  const bookings = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings WHERE barber_id::text = $1::text`, [barberId]);
  const count = Number(bookings.rows?.[0]?.n) || 0;
  if (count > 0) {
    await dbQuery(`UPDATE barbers SET verification_status = 'rejected' WHERE id::text = $1::text`, [barberId]);
    if (row.user_id) {
      await dbQuery(`UPDATE app_users SET account_status = 'disabled' WHERE id = $1::uuid`, [row.user_id]);
    }
    return { ok: true, softDeleted: true, message: "Barber has bookings — suspended instead of deleted." };
  }

  await dbQuery(`DELETE FROM barbers WHERE id::text = $1::text`, [barberId]);
  return { ok: true, softDeleted: false, deleted: true };
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
