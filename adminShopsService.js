/**
 * Global shop roster for super admin / shop-scoped owners.
 */
import { barberBusinessIdSql, parseLocationFields } from "./adminBarberService.js";
import { effectiveShopAccess } from "./shopAccessPolicy.js";
import { dbQuery } from "./db.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pushNotifier = require("./pushNotifier.cjs");

function computeShopAccountStatus(businessStatus, subscriptionStatus, ownerStatus) {
  const biz = String(businessStatus || "active").toLowerCase();
  const sub = String(subscriptionStatus || "inactive").toLowerCase();
  const owner = String(ownerStatus || "active").toLowerCase();
  if (biz === "suspended" || biz === "disabled" || owner === "suspended" || owner === "disabled") {
    return "Suspended";
  }
  if (biz === "pending" || sub === "inactive" || sub === "pending" || owner === "pending") {
    return "Pending";
  }
  return "Active";
}

function formatSubscriptionStatus(plan, subscriptionStatus) {
  const tier = String(plan || "free").toLowerCase();
  const sub = String(subscriptionStatus || "inactive").toLowerCase();
  if (sub === "active" && (tier === "pro" || tier === "elite")) {
    return tier === "elite" ? "Elite" : "Pro";
  }
  if (sub === "active") return "Active";
  if (sub === "inactive") return "Inactive";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function rowToAdminShop(row) {
  const loc = parseLocationFields(row.barber_location, row.city, row.state);
  const address =
    String(row.address || "").trim() ||
    (typeof row.barber_location === "string" && !row.barber_location.startsWith("{")
      ? row.barber_location
      : null) ||
    [loc.city, loc.state].filter(Boolean).join(", ") ||
    null;
  const access = effectiveShopAccess(row);
  const approvalStatus = String(row.approval_status || "pending").toLowerCase();
  const accountStatus = computeShopAccountStatus(row.account_status, row.subscription_status, row.owner_account_status);
  const accessPlan = String(row.access_plan || row.plan || "pending").toLowerCase();

  return {
    id: String(row.business_id),
    businessId: Number(row.business_id),
    shopName: row.name || "—",
    ownerName: row.owner_name || "—",
    ownerEmail: row.owner_email || "—",
    ownerPhone: row.owner_phone || row.shop_phone || null,
    city: loc.city,
    state: loc.state,
    locationLabel: [loc.city, loc.state].filter(Boolean).join(", ") || "—",
    address: address || "—",
    registrationDate: row.created_at ? new Date(row.created_at).toISOString() : null,
    subscriptionStatus: formatSubscriptionStatus(row.plan, row.subscription_status),
    accountStatus,
    approvalStatus: approvalStatus.charAt(0).toUpperCase() + approvalStatus.slice(1),
    accessPlan: accessPlan.charAt(0).toUpperCase() + accessPlan.slice(1),
    freeAccessEnabled: row.free_access_enabled === true,
    paidSubscriptionRequired: row.paid_subscription_required !== false,
    bookingsEnabled: access.bookingsEnabled,
    paymentProcessingEnabled: access.paymentProcessingEnabled,
    platformFeesEnabled: access.platformFeesEnabled !== false,
    subscriptionEnabled: access.subscriptionEnabled !== false,
    websiteAccessEnabled: access.websiteAccessEnabled !== false,
    mobileAppAccessEnabled: access.mobileAppAccessEnabled !== false,
    limitedAccess: access.limitedAccess,
    trialStartedAt: row.trial_started_at ? new Date(row.trial_started_at).toISOString() : null,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    monthlyPrice: Number(row.monthly_price) || 0,
    barberCount: Number(row.barber_count) || 0,
    bookingCount: Number(row.booking_count) || 0,
    customerCount: Number(row.customer_count) || 0,
    totalRevenue: Number(row.total_revenue) || 0,
    platformFees: Number(row.platform_fees) || 0,
    plan: row.plan || "free",
    isActive: accountStatus === "Active" && approvalStatus === "approved",
    pendingApproval: approvalStatus === "pending",
  };
}

const SHOP_SELECT = `
  SELECT
    b.id AS business_id,
    b.name,
    b.phone AS shop_phone,
    b.city,
    b.state,
    b.address,
    b.plan,
    b.subscription_status,
    b.account_status,
    b.approval_status,
    b.access_plan,
    b.free_access_enabled,
    b.paid_subscription_required,
    b.bookings_enabled,
    b.payment_processing_enabled,
    b.platform_fees_enabled,
    b.subscription_enabled,
    b.website_access_enabled,
    b.mobile_app_access_enabled,
    b.trial_started_at,
    b.trial_ends_at,
    b.monthly_price,
    b.created_at,
  (
    SELECT u.name FROM app_users u
    WHERE u.business_id = b.id AND u.role = 'shop_owner'
    ORDER BY u.created_at ASC NULLS LAST
    LIMIT 1
  ) AS owner_name,
  (
    SELECT u.email FROM app_users u
    WHERE u.business_id = b.id AND u.role = 'shop_owner'
    ORDER BY u.created_at ASC NULLS LAST
    LIMIT 1
  ) AS owner_email,
  (
    SELECT u.phone FROM app_users u
    WHERE u.business_id = b.id AND u.role = 'shop_owner'
    ORDER BY u.created_at ASC NULLS LAST
    LIMIT 1
  ) AS owner_phone,
  (
    SELECT u.account_status FROM app_users u
    WHERE u.business_id = b.id AND u.role = 'shop_owner'
    ORDER BY u.created_at ASC NULLS LAST
    LIMIT 1
  ) AS owner_account_status,
  (
    SELECT br.location FROM barbers br
    WHERE ${barberBusinessIdSql("br")} = b.id
    ORDER BY br.created_at ASC NULLS LAST
    LIMIT 1
  ) AS barber_location,
  (
    SELECT COUNT(*)::int FROM barbers br WHERE ${barberBusinessIdSql("br")} = b.id
  ) AS barber_count,
  (
    SELECT COUNT(*)::int FROM bookings bk WHERE bk.business_id = b.id
  ) AS booking_count,
  (
    SELECT COALESCE(SUM(bk.total_price) FILTER (WHERE bk.is_paid_booking = true), 0)::float8
    FROM bookings bk WHERE bk.business_id = b.id
  ) AS total_revenue,
  (
    SELECT COALESCE(SUM(bk.platform_fee) FILTER (WHERE bk.is_paid_booking = true), 0)::float8
    FROM bookings bk WHERE bk.business_id = b.id
  ) AS platform_fees,
  (
    SELECT COUNT(DISTINCT lower(bk.customer_email))::int
    FROM bookings bk
    WHERE bk.business_id = b.id AND bk.customer_email IS NOT NULL AND btrim(bk.customer_email) <> ''
  ) AS customer_count
  FROM businesses b
`;

/**
 * @param {{ all: boolean, businessId?: number }} scope
 * @param {Record<string, string>} filters
 */
export async function listAdminShops(scope, filters = {}) {
  const params = [];
  const where = ["1=1"];

  if (!scope.all) {
    params.push(Number(scope.businessId));
    where.push(`b.id = $${params.length}::bigint`);
  }

  const shop = String(filters.shop || filters.name || "").trim();
  if (shop) {
    params.push(`%${shop.toLowerCase()}%`);
    where.push(`lower(coalesce(b.name, '')) LIKE $${params.length}`);
  }

  const city = String(filters.city || "").trim();
  if (city) {
    params.push(`%${city.toLowerCase()}%`);
    where.push(`lower(coalesce(b.city, '')) LIKE $${params.length}`);
  }

  const state = String(filters.state || "").trim();
  if (state) {
    params.push(`%${state.toLowerCase()}%`);
    where.push(`lower(coalesce(b.state, '')) LIKE $${params.length}`);
  }

  const status = String(filters.status || filters.accountStatus || "").toLowerCase();
  if (String(filters.pendingApproval || "").toLowerCase() === "true") {
    where.push(`lower(coalesce(b.approval_status, 'pending')) = 'pending'`);
  } else if (status === "active") {
    where.push(`lower(coalesce(b.approval_status, 'pending')) = 'approved'`);
    where.push(`lower(coalesce(b.account_status, 'active')) = 'active'`);
  } else if (status === "suspended") {
    where.push(`lower(coalesce(b.account_status, 'active')) IN ('suspended', 'disabled')`);
  } else if (status === "pending") {
    where.push(`lower(coalesce(b.approval_status, 'pending')) = 'pending'`);
  } else if (status === "trial") {
    where.push(`lower(coalesce(b.access_plan, '')) = 'trial'`);
  } else if (status === "free") {
    where.push(`lower(coalesce(b.access_plan, '')) = 'free'`);
  } else if (status === "paid") {
    where.push(`lower(coalesce(b.access_plan, '')) = 'paid'`);
  }

  let orderBy = "b.created_at DESC NULLS LAST";
  const sort = String(filters.sort || "").toLowerCase();
  if (sort === "name" || sort === "shop") orderBy = "b.name ASC NULLS LAST";
  else if (sort === "oldest") orderBy = "b.created_at ASC NULLS LAST";
  else if (sort === "revenue") orderBy = "total_revenue DESC NULLS LAST";

  const sql = `
    ${SHOP_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT 1000
  `;
  const r = await dbQuery(sql, params);
  return (r.rows || []).map(rowToAdminShop);
}

export async function getAdminShopById(businessId) {
  const r = await dbQuery(`${SHOP_SELECT} WHERE b.id = $1::bigint LIMIT 1`, [Number(businessId)]);
  const row = r.rows?.[0];
  if (!row) return null;
  return rowToAdminShop(row);
}

export async function getAdminShopDetail(businessId) {
  const shop = await getAdminShopById(businessId);
  if (!shop) return null;

  const [barbersR, servicesR, bookingsR, customersR] = await Promise.all([
    dbQuery(
      `SELECT b.id, b.name, b.phone, b.verification_status, u.email, u.account_status
       FROM barbers b
       LEFT JOIN app_users u ON u.id = b.user_id
       WHERE ${barberBusinessIdSql("b")} = $1::bigint
       ORDER BY b.name ASC NULLS LAST
       LIMIT 200`,
      [Number(businessId)],
    ),
    dbQuery(
      `SELECT s.id, s.name, s.price::float8 AS price, s.duration_minutes, s.is_active, s.barber_id, b.name AS barber_name
       FROM barber_services s
       JOIN barbers b ON b.id = s.barber_id
       WHERE ${barberBusinessIdSql("b")} = $1::bigint
       ORDER BY b.name, s.name
       LIMIT 500`,
      [Number(businessId)],
    ),
    dbQuery(
      `SELECT id, customer_name AS name, customer_email AS email, barber_name AS barber,
              service, date::text AS date, total_price::float8 AS total_price,
              platform_fee::float8 AS platform_fee, payment_status, booking_status, created_at
       FROM bookings
       WHERE business_id = $1::bigint
       ORDER BY created_at DESC
       LIMIT 100`,
      [Number(businessId)],
    ),
    dbQuery(
      `SELECT customer_name AS name, customer_email AS email, phone, MAX(created_at) AS last_booking
       FROM bookings
       WHERE business_id = $1::bigint AND customer_email IS NOT NULL AND btrim(customer_email) <> ''
       GROUP BY customer_name, customer_email, phone
       ORDER BY MAX(created_at) DESC
       LIMIT 200`,
      [Number(businessId)],
    ).catch(() => ({ rows: [] })),
  ]);

  const stylesR = await dbQuery(
    `SELECT st.id, st.title, st.image_url, st.barber_id, b.name AS barber_name
     FROM styles st
     JOIN barbers b ON b.id::text = st.barber_id::text
     WHERE ${barberBusinessIdSql("b")} = $1::bigint
     ORDER BY st.created_at DESC NULLS LAST
     LIMIT 100`,
    [Number(businessId)],
  ).catch(() => ({ rows: [] }));

  return {
    shop,
    barbers: (barbersR.rows || []).map((b) => ({
      id: String(b.id),
      name: b.name || "—",
      email: b.email || null,
      phone: b.phone || null,
      verificationStatus: b.verification_status || "pending",
      accountStatus: b.account_status || "active",
    })),
    services: (servicesR.rows || []).map((s) => ({
      id: String(s.id),
      name: s.name || "—",
      price: Number(s.price) || 0,
      durationMinutes: s.duration_minutes || 30,
      isActive: s.is_active !== false,
      barberId: String(s.barber_id),
      barberName: s.barber_name || "—",
    })),
    stylePhotos: (stylesR.rows || []).map((st) => ({
      id: String(st.id),
      title: st.title || "Style",
      imageUrl: st.image_url || null,
      barberId: String(st.barber_id),
      barberName: st.barber_name || "—",
    })),
    bookings: (bookingsR.rows || []).map((bk) => ({
      id: String(bk.id),
      name: bk.name || "—",
      email: bk.email || null,
      barber: bk.barber || "—",
      service: bk.service || "—",
      date: bk.date || null,
      totalPrice: Number(bk.total_price) || 0,
      platformFee: Number(bk.platform_fee) || 0,
      paymentStatus: bk.payment_status || null,
      bookingStatus: bk.booking_status || null,
      createdAt: bk.created_at ? new Date(bk.created_at).toISOString() : null,
    })),
    customers: (customersR.rows || []).map((c) => ({
      name: c.name || "—",
      email: c.email || "—",
      phone: c.phone || null,
      lastBooking: c.last_booking ? new Date(c.last_booking).toISOString() : null,
    })),
  };
}

export async function updateAdminShop(businessId, { name, phone, city, state, address, plan, subscriptionStatus }) {
  const r = await dbQuery(
    `UPDATE businesses SET
       name = COALESCE(NULLIF($2::text, ''), name),
       phone = COALESCE($3::text, phone),
       city = COALESCE(NULLIF($4::text, ''), city),
       state = COALESCE(NULLIF($5::text, ''), state),
       address = COALESCE(NULLIF($6::text, ''), address),
       plan = COALESCE(NULLIF($7::text, ''), plan),
       subscription_status = COALESCE(NULLIF($8::text, ''), subscription_status)
     WHERE id = $1::bigint
     RETURNING id`,
    [
      Number(businessId),
      name != null ? String(name).trim() : null,
      phone != null ? String(phone).trim() || null : null,
      city != null ? String(city).trim() : null,
      state != null ? String(state).trim() : null,
      address != null ? String(address).trim() : null,
      plan != null ? String(plan).trim() : null,
      subscriptionStatus != null ? String(subscriptionStatus).trim() : null,
    ],
  );
  return r.rows?.length > 0;
}

export async function setShopAccountStatus(businessId, status) {
  const mapped = String(status || "").toLowerCase();
  const allowed = ["active", "pending", "suspended", "disabled"];
  if (!allowed.includes(mapped)) return { ok: false, message: "Invalid status" };

  await dbQuery(`UPDATE businesses SET account_status = $1 WHERE id = $2::bigint`, [
    mapped,
    Number(businessId),
  ]);

  const ownerStatus = mapped === "active" ? "active" : mapped === "pending" ? "pending" : "suspended";
  await dbQuery(
    `UPDATE app_users SET account_status = $1
     WHERE business_id = $2::bigint AND role = 'shop_owner'`,
    [ownerStatus, Number(businessId)],
  ).catch(() => {});

  return { ok: true };
}

export async function deleteAdminShop(businessId) {
  const bid = Number(businessId);
  const bookings = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings WHERE business_id = $1`, [bid]);
  const count = Number(bookings.rows?.[0]?.n) || 0;
  if (count > 0) {
    await setShopAccountStatus(bid, "disabled");
    return { ok: true, softDeleted: true, message: "Shop has bookings — marked disabled instead of deleted." };
  }
  await dbQuery(
    `DELETE FROM barber_services WHERE barber_id IN (SELECT id FROM barbers WHERE business_id = $1)`,
    [bid],
  ).catch(() => {});
  await dbQuery(`DELETE FROM barbers WHERE business_id = $1`, [bid]).catch(() => {});
  await dbQuery(`UPDATE app_users SET business_id = NULL WHERE business_id = $1`, [bid]).catch(() => {});
  await dbQuery(`DELETE FROM businesses WHERE id = $1`, [bid]);
  return { ok: true, softDeleted: false };
}

export async function getAdminShopDashboard() {
  const r = await dbQuery(`
    SELECT
      COUNT(*)::int AS total_shops,
      COUNT(*) FILTER (WHERE lower(coalesce(approval_status, 'pending')) = 'pending')::int AS pending_approval,
      COUNT(*) FILTER (
        WHERE lower(coalesce(approval_status, '')) = 'approved'
          AND lower(coalesce(access_plan, '')) = 'paid'
          AND lower(coalesce(account_status, 'active')) = 'active'
          AND lower(coalesce(subscription_status, '')) = 'active'
      )::int AS active_paid_shops,
      COUNT(*) FILTER (
        WHERE lower(coalesce(approval_status, '')) = 'approved'
          AND lower(coalesce(access_plan, '')) = 'free'
      )::int AS free_shops,
      COUNT(*) FILTER (
        WHERE lower(coalesce(access_plan, '')) = 'trial'
          AND (trial_ends_at IS NULL OR trial_ends_at > NOW())
      )::int AS trial_shops,
      COUNT(*) FILTER (
        WHERE lower(coalesce(account_status, 'active')) IN ('suspended', 'disabled')
      )::int AS suspended_shops,
      COALESCE(SUM(monthly_price) FILTER (
        WHERE lower(coalesce(access_plan, '')) = 'paid'
          AND lower(coalesce(subscription_status, '')) = 'active'
          AND lower(coalesce(account_status, 'active')) = 'active'
      ), 0)::float8 AS mrr
    FROM businesses
  `);
  const feesR = await dbQuery(
    `SELECT COALESCE(SUM(platform_fee) FILTER (WHERE is_paid_booking = true), 0)::float8 AS platform_fee_revenue FROM bookings`,
  );
  const row = r.rows?.[0] || {};
  return {
    totalShops: Number(row.total_shops) || 0,
    pendingApproval: Number(row.pending_approval) || 0,
    activePaidShops: Number(row.active_paid_shops) || 0,
    freeShops: Number(row.free_shops) || 0,
    trialShops: Number(row.trial_shops) || 0,
    suspendedShops: Number(row.suspended_shops) || 0,
    mrr: Number(row.mrr) || 0,
    platformFeeRevenue: Number(feesR.rows?.[0]?.platform_fee_revenue) || 0,
  };
}

export async function resolveSuperAdminUserIds() {
  const r = await dbQuery(`SELECT id FROM app_users WHERE role = 'super_admin'`);
  return (r.rows || []).map((row) => String(row.id)).filter(Boolean);
}

export async function notifySuperAdminsNewShop({ businessId, shopName, ownerName, city, state, email }) {
  const title = "New shop registration";
  const location = [city, state].filter(Boolean).join(", ");
  const body = `${shopName || "A new shop"} registered${ownerName ? ` by ${ownerName}` : ""}${location ? ` (${location})` : ""} — awaiting approval.`;

  const adminIds = await resolveSuperAdminUserIds();
  if (!adminIds.length) return { ok: true, notified: 0 };

  const payload = { businessId: Number(businessId), email: email || null, shopName: shopName || null };

  for (const userId of adminIds) {
    await dbQuery(
      `INSERT INTO admin_user_notifications (user_id, kind, title, body, payload)
       VALUES ($1::uuid, 'shop_registered', $2, $3, $4::jsonb)`,
      [userId, title, body, JSON.stringify(payload)],
    ).catch(() => {});
  }

  void pushNotifier.sendPushToUsers({
    dbQuery,
    userIds: adminIds,
    kind: "admin_alert",
    title,
    body,
    data: { businessId: String(businessId), type: "shop_registered" },
  }).catch(() => {});

  return { ok: true, notified: adminIds.length };
}

const PLAN_DEFAULTS = {
  free: { plan: "free", subscription_status: "active", monthly_price: 0, paid_subscription_required: false },
  trial: { plan: "pro", subscription_status: "trial", monthly_price: 0, paid_subscription_required: true },
  paid: { plan: "pro", subscription_status: "active", monthly_price: 9.99, paid_subscription_required: true },
  lifetime_free: {
    plan: "free",
    subscription_status: "active",
    monthly_price: 0,
    paid_subscription_required: false,
  },
};

export async function approveShop(businessId, { plan = "free", trialDays = 14, monthlyPrice }, actorId) {
  const accessPlan = String(plan || "free").toLowerCase();
  if (!["free", "trial", "paid", "lifetime_free"].includes(accessPlan)) {
    return { ok: false, message: "plan must be free, trial, paid, or lifetime_free" };
  }
  const defs = PLAN_DEFAULTS[accessPlan];
  const price = monthlyPrice != null ? Number(monthlyPrice) : defs.monthly_price;

  let trialStart = null;
  let trialEnd = null;
  if (accessPlan === "trial") {
    trialStart = new Date();
    trialEnd = new Date(Date.now() + Number(trialDays || 14) * 24 * 60 * 60 * 1000);
  }

  await dbQuery(
    `UPDATE businesses SET
       approval_status = 'approved',
       account_status = 'active',
       access_plan = $2,
       plan = $3,
       subscription_status = $4,
       monthly_price = $5,
       paid_subscription_required = $6,
       free_access_enabled = $7,
       subscription_enabled = $8,
       bookings_enabled = true,
       payment_processing_enabled = true,
       trial_started_at = $9,
       trial_ends_at = $10,
       approved_at = NOW(),
       approved_by = $11::uuid,
       rejection_reason = NULL
     WHERE id = $1::bigint`,
    [
      Number(businessId),
      accessPlan,
      defs.plan,
      defs.subscription_status,
      price,
      accessPlan === "paid" || accessPlan === "trial",
      accessPlan === "free" || accessPlan === "lifetime_free",
      accessPlan === "lifetime_free" ? false : true,
      trialStart,
      trialEnd,
      actorId || null,
    ],
  );

  await dbQuery(
    `UPDATE app_users SET account_status = 'active'
     WHERE business_id = $1::bigint AND role IN ('shop_owner', 'barber')`,
    [Number(businessId)],
  ).catch(() => {});

  return { ok: true };
}

export async function rejectShop(businessId, reason, actorId) {
  await dbQuery(
    `UPDATE businesses SET
       approval_status = 'rejected',
       account_status = 'disabled',
       bookings_enabled = false,
       payment_processing_enabled = false,
       rejection_reason = $2,
       approved_by = $3::uuid
     WHERE id = $1::bigint`,
    [Number(businessId), reason ? String(reason).slice(0, 500) : null, actorId || null],
  );
  await dbQuery(
    `UPDATE app_users SET account_status = 'disabled'
     WHERE business_id = $1::bigint AND role IN ('shop_owner', 'barber')`,
    [Number(businessId)],
  ).catch(() => {});
  return { ok: true };
}

export async function updateShopAccessControls(businessId, controls = {}) {
  const sets = [];
  const params = [Number(businessId)];
  let i = 2;

  const boolFields = [
    ["freeAccessEnabled", "free_access_enabled"],
    ["paidSubscriptionRequired", "paid_subscription_required"],
    ["bookingsEnabled", "bookings_enabled"],
    ["paymentProcessingEnabled", "payment_processing_enabled"],
    ["platformFeesEnabled", "platform_fees_enabled"],
    ["subscriptionEnabled", "subscription_enabled"],
    ["websiteAccessEnabled", "website_access_enabled"],
    ["mobileAppAccessEnabled", "mobile_app_access_enabled"],
  ];
  for (const [key, col] of boolFields) {
    if (controls[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(Boolean(controls[key]));
    }
  }
  if (controls.accessPlan != null) {
    const plan = String(controls.accessPlan).trim().toLowerCase();
    if (["free", "trial", "paid", "lifetime_free", "pending"].includes(plan)) {
      sets.push(`access_plan = $${i++}`);
      params.push(plan);
    }
  }
  if (controls.subscriptionStatus != null) {
    sets.push(`subscription_status = $${i++}`);
    params.push(String(controls.subscriptionStatus).trim().toLowerCase());
  }
  if (controls.monthlyPrice != null) {
    sets.push(`monthly_price = $${i++}`);
    params.push(Number(controls.monthlyPrice) || 0);
  }
  if (!sets.length) return { ok: true };
  await dbQuery(`UPDATE businesses SET ${sets.join(", ")} WHERE id = $1::bigint`, params);
  return { ok: true };
}

export async function startShopTrial(businessId, trialDays = 14) {
  const start = new Date();
  const end = new Date(Date.now() + Number(trialDays || 14) * 24 * 60 * 60 * 1000);
  await dbQuery(
    `UPDATE businesses SET
       access_plan = 'trial',
       subscription_status = 'trial',
       trial_started_at = $2,
       trial_ends_at = $3,
       bookings_enabled = true,
       payment_processing_enabled = true,
       approval_status = 'approved',
       account_status = 'active'
     WHERE id = $1::bigint`,
    [Number(businessId), start, end],
  );
  return { ok: true, trialEndsAt: end.toISOString() };
}

export async function endShopTrial(businessId) {
  await dbQuery(
    `UPDATE businesses SET
       trial_ends_at = NOW(),
       bookings_enabled = false,
       payment_processing_enabled = false,
       subscription_status = 'inactive'
     WHERE id = $1::bigint`,
    [Number(businessId)],
  );
  return { ok: true };
}
