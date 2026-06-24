/**
 * Provisions barber / shop-owner records after lightweight auth registration
 * so mobile signups appear in Super Admin approval queues.
 */
import { dbQuery } from "./db.js";
import { ensureAdminShopManagementSchema, NEW_SHOP_PENDING_DEFAULTS } from "./adminShopMigrations.js";
import { ensureAdminBarberManagementSchema } from "./adminBarberMigrations.js";
import { notifySuperAdminsNewBarber, parseLocationFields } from "./adminBarberService.js";
import { notifySuperAdminsNewShop } from "./adminShopsService.js";
import { getShopAccess } from "./shopAccessPolicy.js";
import { ensureAppUsersBarberIdTypeAligned } from "./authDbMigrations.js";
import { getBarbersIdColumnType, getTableBarberIdType } from "./barberScheduleMigrations.js";

function buildLocationJson({ address, city, state, location }) {
  const addr = String(address || location || "").trim();
  const c = String(city || "").trim();
  const s = String(state || "").trim();
  if (!addr && !c && !s) return null;
  return JSON.stringify({ address: addr, city: c, state: s });
}

async function insertPendingBusiness({ name, phone, address, city, state }) {
  await ensureAdminShopManagementSchema();
  const d = NEW_SHOP_PENDING_DEFAULTS;
  try {
    const r = await dbQuery(
      `INSERT INTO businesses (
         name, phone, address, city, state, plan, subscription_status,
         account_status, approval_status, access_plan,
         free_access_enabled, paid_subscription_required,
         bookings_enabled, payment_processing_enabled
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        name,
        phone,
        address || null,
        city || null,
        state || null,
        d.plan,
        d.subscription_status,
        d.account_status,
        d.approval_status,
        d.access_plan,
        d.free_access_enabled,
        d.paid_subscription_required,
        d.bookings_enabled,
        d.payment_processing_enabled,
      ],
    );
    return r.rows?.[0]?.id;
  } catch (e) {
    const err = new Error(`business_insert_failed: ${e?.message || e}`);
    err.code = e?.code;
    throw err;
  }
}

async function linkAppUserToBarberRecords({ userId, role, phoneVal, barberId, businessId, forcePending = true }) {
  await ensureAppUsersBarberIdTypeAligned().catch(() => {});
  const appBarberColType = await getTableBarberIdType("app_users");
  const params = [userId, phoneVal, role, businessId];
  const pendingSql = forcePending
    ? `, account_status = CASE
         WHEN lower(coalesce(account_status, 'active')) IN ('active', '') THEN 'pending'
         ELSE account_status
       END`
    : "";
  let barberSql = "";
  if (appBarberColType === "uuid") {
    params.push(barberId);
    barberSql = `, barber_id = $${params.length}::uuid`;
  } else if (/^[0-9]+$/.test(String(barberId))) {
    params.push(Number(barberId));
    barberSql = `, barber_id = $${params.length}`;
  }
  await dbQuery(
    `UPDATE app_users
     SET phone = COALESCE($2, phone), role = $3, business_id = $4${pendingSql}${barberSql}
     WHERE id = $1::uuid`,
    params,
  );
}

async function insertBarberSettingsRow(barberId) {
  if (barberId == null) return;
  const colType = await getTableBarberIdType("barber_settings");
  try {
    if (colType === "uuid") {
      await dbQuery(
        `INSERT INTO barber_settings (barber_id, subscription_tier)
         VALUES ($1::uuid, 'pro')
         ON CONFLICT (barber_id) DO NOTHING`,
        [String(barberId)],
      );
      return;
    }
    if (/^\d+$/.test(String(barberId))) {
      await dbQuery(
        `INSERT INTO barber_settings (barber_id, subscription_tier)
         VALUES ($1, 'pro')
         ON CONFLICT (barber_id) DO NOTHING`,
        [Number(barberId)],
      );
    }
  } catch (e) {
    console.warn("[signup] barber_settings insert skipped:", e?.message || e);
  }
}

async function createBarberRowForUser({
  userId,
  displayName,
  shop,
  businessId,
  phoneVal,
  locationJson,
  verificationStatus = "pending",
}) {
  const barbersIdType = await getBarbersIdColumnType();
  let barberIns;
  try {
    barberIns =
      barbersIdType === "uuid"
        ? await dbQuery(
            `INSERT INTO barbers (id, name, shop_name, business_id, user_id, phone, location, verification_status)
             VALUES (gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6, $7)
             RETURNING id`,
            [displayName, shop, businessId, userId, phoneVal, locationJson, verificationStatus],
          )
        : await dbQuery(
            `INSERT INTO barbers (name, shop_name, business_id, user_id, phone, location, verification_status)
             VALUES ($1, $2, $3, $4::uuid, $5, $6, $7)
             RETURNING id`,
            [displayName, shop, businessId, userId, phoneVal, locationJson, verificationStatus],
          );
  } catch (e) {
    const err = new Error(`barber_insert_failed: ${e?.message || e}`);
    err.code = e?.code;
    throw err;
  }
  const barberId = barberIns.rows?.[0]?.id;
  if (barberId == null) throw new Error("barber_insert_failed");
  return barberId;
}

/**
 * Barber self-signup: business + barber row + pending verification.
 */
export async function provisionBarberSignup({
  userId,
  name,
  email,
  phone,
  shopName,
  location,
  address,
  city,
  state,
}) {
  await ensureAdminBarberManagementSchema();
  await ensureAdminShopManagementSchema();

  const displayName = String(name || "Barber").trim();
  const shop = String(shopName || "").trim() || `${displayName} Shop`;
  const phoneVal = String(phone || "").trim() || null;
  const locationJson = buildLocationJson({ address, city, state, location });
  const loc = parseLocationFields(locationJson, city, state);

  const businessId = await insertPendingBusiness({
    name: shop,
    phone: phoneVal,
    address: String(address || location || "").trim() || null,
    city: loc.city,
    state: loc.state,
  });
  if (businessId == null) throw new Error("business_insert_failed");

  const barberId = await createBarberRowForUser({
    userId,
    displayName,
    shop,
    businessId,
    phoneVal,
    locationJson,
    verificationStatus: "pending",
  });

  await linkAppUserToBarberRecords({
    userId,
    role: "barber",
    phoneVal,
    barberId,
    businessId,
    forcePending: true,
  });

  await insertBarberSettingsRow(barberId);

  void notifySuperAdminsNewBarber({
    barberId,
    fullName: displayName,
    shopName: shop,
    city: loc.city,
    state: loc.state,
    email,
  });
  void notifySuperAdminsNewShop({
    businessId,
    shopName: shop,
    ownerName: displayName,
    city: loc.city,
    state: loc.state,
    email,
  });

  return { barberId, businessId, approvalStatus: "pending" };
}

/**
 * Shop owner self-signup: business + optional owner barber row + pending approval.
 */
export async function provisionShopOwnerSignup({
  userId,
  name,
  email,
  phone,
  businessName,
  address,
  city,
  state,
}) {
  await ensureAdminBarberManagementSchema();
  await ensureAdminShopManagementSchema();

  const ownerName = String(name || "Owner").trim();
  const shop = String(businessName || "").trim();
  const phoneVal = String(phone || "").trim() || null;
  const addr = String(address || "").trim();
  const cityVal = String(city || "").trim();
  const stateVal = String(state || "").trim();

  const businessId = await insertPendingBusiness({
    name: shop,
    phone: phoneVal,
    address: addr || null,
    city: cityVal || null,
    state: stateVal || null,
  });
  if (businessId == null) throw new Error("business_insert_failed");

  const barberId = await createBarberRowForUser({
    userId,
    displayName: ownerName,
    shop,
    businessId,
    phoneVal,
    locationJson: null,
    verificationStatus: "pending",
  });

  await linkAppUserToBarberRecords({
    userId,
    role: "shop_owner",
    phoneVal,
    barberId,
    businessId,
    forcePending: true,
  });

  await insertBarberSettingsRow(barberId);

  await dbQuery(
    `INSERT INTO barber_services (barber_id, business_id, name, price, duration_minutes, is_active)
     VALUES ($1, $2, 'General cut', 25, 30, false)`,
    [barberId, businessId],
  ).catch(() => {});

  void notifySuperAdminsNewBarber({
    barberId,
    fullName: ownerName,
    shopName: shop,
    city: cityVal,
    state: stateVal,
    email,
  });
  void notifySuperAdminsNewShop({
    businessId,
    shopName: shop,
    ownerName,
    city: cityVal,
    state: stateVal,
    email,
  });

  return { barberId, businessId, approvalStatus: "pending" };
}

/** Effective approval / access state for session responses. */
export async function resolveUserApprovalState(user) {
  const accountStatus = String(user?.account_status || "active").toLowerCase();
  if (["pending", "disabled", "suspended"].includes(accountStatus)) {
    return {
      approvalStatus: accountStatus,
      limitedAccess: accountStatus !== "active",
      message:
        accountStatus === "pending"
          ? "Your account is pending Super Admin approval."
          : "Your account is suspended. Contact support.",
    };
  }

  const barberId = user?.barber_id;
  if (barberId != null) {
    const r = await dbQuery(
      `SELECT verification_status FROM barbers WHERE id::text = $1::text LIMIT 1`,
      [String(barberId)],
    );
    const v = String(r.rows?.[0]?.verification_status || "pending").toLowerCase();
    if (v === "pending") {
      return {
        approvalStatus: "pending",
        limitedAccess: true,
        message: "Your barber profile is pending Super Admin approval.",
      };
    }
    if (v === "rejected") {
      return {
        approvalStatus: "rejected",
        limitedAccess: true,
        message: "Your barber registration was not approved.",
      };
    }
  }

  const bizId = user?.business_id;
  if (bizId != null && Number.isFinite(Number(bizId))) {
    const access = await getShopAccess(Number(bizId));
    if (!access.approved) {
      return {
        approvalStatus: access.reason || "pending_approval",
        limitedAccess: true,
        message:
          access.reason === "shop_rejected"
            ? "Your shop registration was not approved."
            : "Your shop is pending Super Admin approval.",
      };
    }
  }

  return { approvalStatus: "approved", limitedAccess: false, message: null };
}

/** Counts for Super Admin diagnostics — orphan = app_users barber role without barbers row. */
export async function getBarberSignupAudit() {
  const [barbers, users, orphans, pendingBarbers, pendingUsers] = await Promise.all([
    dbQuery(`SELECT COUNT(*)::int AS c FROM barbers`),
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM app_users WHERE lower(coalesce(role, '')) IN ('barber', 'shop_owner')`,
    ),
    dbQuery(
      `SELECT COUNT(*)::int AS c
       FROM app_users u
       WHERE lower(coalesce(u.role, '')) IN ('barber', 'shop_owner')
         AND NOT EXISTS (SELECT 1 FROM barbers b WHERE b.user_id = u.id)`,
    ),
    dbQuery(
      `SELECT COUNT(*)::int AS c FROM barbers WHERE lower(coalesce(verification_status, 'pending')) = 'pending'`,
    ),
    dbQuery(
      `SELECT COUNT(*)::int AS c
       FROM app_users u
       WHERE lower(coalesce(u.role, '')) IN ('barber', 'shop_owner')
         AND lower(coalesce(u.account_status, 'active')) = 'pending'`,
    ),
  ]);

  const orphanSample = await dbQuery(
    `SELECT u.id, u.name, u.email, u.role, u.account_status, u.created_at
     FROM app_users u
     WHERE lower(coalesce(u.role, '')) IN ('barber', 'shop_owner')
       AND NOT EXISTS (SELECT 1 FROM barbers b WHERE b.user_id = u.id)
     ORDER BY u.created_at DESC NULLS LAST
     LIMIT 25`,
  );

  const barbersIdType = await getBarbersIdColumnType();
  const appBarberIdType = await getTableBarberIdType("app_users");

  return {
    databaseUrlConfigured: Boolean(String(process.env.DATABASE_URL || "").trim()),
    barbersIdType: barbersIdType,
    appUsersBarberIdType: appBarberIdType,
    totalBarberRows: barbers.rows?.[0]?.c ?? 0,
    totalBarberRoleUsers: users.rows?.[0]?.c ?? 0,
    orphanRegistrations: orphans.rows?.[0]?.c ?? 0,
    pendingVerificationBarbers: pendingBarbers.rows?.[0]?.c ?? 0,
    pendingAccountUsers: pendingUsers.rows?.[0]?.c ?? 0,
    orphanSample: (orphanSample.rows || []).map((r) => ({
      id: String(r.id),
      name: r.name,
      email: r.email,
      role: r.role,
      accountStatus: r.account_status,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Repair historical signups that only created `app_users` (no `barbers` row).
 * Safe to run on every Super Admin barber list load and once on server boot.
 */
export async function backfillOrphanBarberRegistrations({ notify = false } = {}) {
  await ensureAdminBarberManagementSchema();
  await ensureAdminShopManagementSchema();
  await ensureAppUsersBarberIdTypeAligned().catch((e) => {
    console.warn("[backfill] app_users.barber_id align skipped:", e?.message || e);
  });

  const r = await dbQuery(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.business_id, u.account_status, u.created_at
     FROM app_users u
     WHERE lower(coalesce(u.role, '')) IN ('barber', 'shop_owner')
       AND NOT EXISTS (SELECT 1 FROM barbers b WHERE b.user_id = u.id)
     ORDER BY u.created_at ASC NULLS LAST
     LIMIT 500`,
  );

  const rows = r.rows || [];
  let fixed = 0;
  const errors = [];

  for (const row of rows) {
    const userId = String(row.id);
    const name = String(row.name || "Barber").trim() || "Barber";
    const email = String(row.email || "").trim();
    const phone = String(row.phone || "").trim() || null;
    const role = String(row.role || "barber").toLowerCase();
    const emailLocal = email.split("@")[0] || "shop";
    const shopDefault = `${name} Shop`;

    try {
      if (Number.isFinite(Number(row.business_id))) {
        const businessId = Number(row.business_id);
        const barberId = await createBarberRowForUser({
          userId,
          displayName: name,
          shop: shopDefault,
          businessId,
          phoneVal: phone,
          locationJson: null,
          verificationStatus: "pending",
        });
        await linkAppUserToBarberRecords({
          userId,
          role,
          phoneVal: phone,
          barberId,
          businessId,
          forcePending: String(row.account_status || "").toLowerCase() !== "active",
        });
        await insertBarberSettingsRow(barberId);
        fixed += 1;
        continue;
      }

      if (role === "shop_owner") {
        await provisionShopOwnerSignup({
          userId,
          name,
          email,
          phone: phone || "0000000000",
          businessName: shopDefault,
          address: "Pending — address not provided at signup",
          city: "Pending",
          state: "—",
        });
      } else {
        await provisionBarberSignup({
          userId,
          name,
          email,
          phone: phone || "0000000000",
          shopName: shopDefault,
          address: `Pending registration (${emailLocal})`,
          city: "Pending",
          state: "—",
        });
      }
      fixed += 1;
      if (notify) {
        void notifySuperAdminsNewBarber({
          barberId: null,
          fullName: name,
          shopName: shopDefault,
          city: "Pending",
          state: "—",
          email,
        });
      }
    } catch (e) {
      errors.push({ email, message: e?.message || String(e) });
      console.warn("[backfill] orphan barber failed:", email, e?.message || e);
    }
  }

  return { scanned: rows.length, fixed, errors };
}
