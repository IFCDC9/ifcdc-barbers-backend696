import { dbQuery } from "./db.js";
import { depositsAllowedForBooking } from "./styleBookingPricing.js";
import {
  barberAuraEffective,
  barberDepositsEffective,
  normalizeBillingProvider,
  normalizeTier,
  platformFeeUsdForTier,
  TIER_FREE,
} from "./subscriptionTier.js";

function parseTimeToMinutes(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

/**
 * @param {number} barberId
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM or HH:MM:SS
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function assertSlotWithinAvailability(barberId, dateStr, timeStr, barberName = "") {
  const { coerceBarberIdForTable } = await import("./barberIdentity.cjs");
  const bid = await coerceBarberIdForTable(dbQuery, "barber_availability", barberId, barberName);
  if (bid == null) return { ok: false, message: "Invalid barber" };

  const r = await dbQuery(
    `SELECT day_of_week, start_time, end_time, is_off
     FROM barber_availability
     WHERE barber_id = $1`,
    [bid],
  );
  const rows = r.rows || [];
  if (!rows.length) return { ok: true };

  let d;
  try {
    d = new Date(`${dateStr}T12:00:00`);
  } catch {
    return { ok: false, message: "Invalid date" };
  }
  if (Number.isNaN(d.getTime())) return { ok: false, message: "Invalid date" };

  const dow = d.getDay();
  const bookingMin = parseTimeToMinutes(timeStr);
  if (bookingMin == null) return { ok: false, message: "Invalid time" };

  const intervals = rows.filter((row) => Number(row.day_of_week) === dow && !row.is_off);
  if (!intervals.length) {
    return { ok: false, message: "Shop is closed that day — pick another date." };
  }

  for (const row of intervals) {
    const start = parseTimeToMinutes(row.start_time);
    const end = parseTimeToMinutes(row.end_time);
    if (start == null || end == null) continue;
    if (bookingMin >= start && bookingMin < end) return { ok: true };
  }

  return { ok: false, message: "That time is outside posted hours for this day." };
}

/**
 * @param {string} userId UUID
 * @returns {Promise<number>}
 */
export async function ensureBarberForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("user_id_required");

  const existing = await dbQuery(`SELECT barber_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [uid]);
  const linked = existing.rows?.[0]?.barber_id;
  if (linked != null) {
    const check = await dbQuery(`SELECT id FROM barbers WHERE id::text = $1 LIMIT 1`, [String(linked)]);
    if (check.rows?.length) return check.rows[0].id;
  }

  const u = await dbQuery(`SELECT name, email FROM app_users WHERE id = $1::uuid LIMIT 1`, [uid]);
  const row = u.rows?.[0];
  const displayName = String(row?.name || row?.email || "Barber").trim() || "Barber";

  const ins = await dbQuery(
    `INSERT INTO barbers (user_id, name) VALUES ($1::uuid, $2) RETURNING id`,
    [uid, displayName],
  );
  const newId = ins.rows?.[0]?.id;
  if (newId == null) throw new Error("barber_create_failed");

  await dbQuery(`UPDATE app_users SET barber_id = $1 WHERE id = $2::uuid`, [newId, uid]);
  await dbQuery(
    `INSERT INTO barber_settings (barber_id) VALUES ($1) ON CONFLICT (barber_id) DO NOTHING`,
    [newId],
  );

  return newId;
}

/**
 * @param {{ role?: string, id?: string }} user
 * @param {string | undefined} queryBarberId from ?barberId=
 * @returns {Promise<{ barberId: number } | { error: string, status: number, message: string }>}
 */
export async function resolveScopedBarberId(user, queryBarberId) {
  const role = String(user?.role || "").trim();
  const raw = queryBarberId != null ? String(queryBarberId).trim() : "";
  const isGlobalAdmin =
    role === "super_admin" || role === "admin" || user?.isSuperAdmin === true || user?.isOwner === true;

  async function lookupBarberId(idText) {
    const r = await dbQuery(`SELECT id FROM barbers WHERE id::text = $1 LIMIT 1`, [idText]);
    return r.rows?.[0]?.id ?? null;
  }

  if (isGlobalAdmin) {
    if (!raw) {
      return {
        error: "barber_id_required",
        status: 400,
        message: "Pass barberId or barber_id (query or body).",
      };
    }
    const id = await lookupBarberId(raw);
    if (id == null) {
      return { error: "barber_not_found", status: 404, message: "Barber not found." };
    }
    return { barberId: id };
  }

  if (role === "barber") {
    const id = await ensureBarberForUser(String(user.id));
    return { barberId: id };
  }

  if (role === "shop_owner") {
    if (!raw) {
      return {
        error: "barber_id_required",
        status: 400,
        message: "Pass barberId or barber_id (query or body).",
      };
    }
    const shop = await dbQuery(
      `SELECT u.business_id FROM app_users u WHERE u.id = $1::uuid AND u.role = 'shop_owner' LIMIT 1`,
      [String(user.id)],
    );
    const bizId = shop.rows?.[0]?.business_id;
    if (bizId == null) {
      return { error: "forbidden", status: 403, message: "Shop owner account is not linked to a business." };
    }
    const ok = await dbQuery(
      `SELECT id FROM barbers WHERE id::text = $1 AND business_id = $2 LIMIT 1`,
      [raw, Number(bizId)],
    );
    if (!ok.rows?.length) {
      return { error: "forbidden", status: 403, message: "That barber is not in your shop." };
    }
    return { barberId: ok.rows[0].id };
  }

  return { error: "forbidden", status: 403, message: "Client accounts cannot manage barber settings." };
}

/**
 * @param {number} barberId
 * @returns {Promise<{
 *   booking_deposit_enabled: boolean,
 *   deposit_amount: number,
 *   payment_method: string,
 *   aura_enabled: boolean,
 *   aura_available: boolean,
 *   booking_deposit_available: boolean,
 *   aura_voice_type: string,
 *   language: string,
 *   theme_color: string,
 *   subscription_tier: "free"|"pro"|"elite",
 *   subscription_monthly_price: number | null,
 *   billing_provider: string,
 *   billing_subscription_id: string | null,
 * }>}
 */
export async function loadBarberSettingsRow(barberId, barberName = "") {
  const { coerceBarberIdForTable } = await import("./barberIdentity.cjs");
  const bid = await coerceBarberIdForTable(dbQuery, "barber_settings", barberId, barberName);
  const settingsKey = bid ?? barberId;
  const r = await dbQuery(
    `SELECT theme_color, booking_deposit_enabled, deposit_amount::float8 AS deposit_amount,
            payment_method, aura_enabled, aura_voice_type, language,
            subscription_tier, subscription_monthly_price::float8 AS subscription_monthly_price,
            billing_provider, billing_subscription_id,
            is_pro, pro_purchase_status, pro_transaction_id, pro_purchased_at
     FROM barber_settings
     WHERE barber_id = $1
     LIMIT 1`,
    [settingsKey],
  );
  const row = r.rows?.[0];
  if (!row) {
    const base = {
      theme_color: "#FFD700",
      booking_deposit_enabled: false,
      deposit_amount: 0,
      payment_method: "paypal",
      aura_enabled: true,
      aura_voice_type: "Polly.Joanna",
      language: "en",
      subscription_tier: TIER_FREE,
      subscription_monthly_price: null,
      billing_provider: "none",
      billing_subscription_id: null,
      is_pro: false,
      pro_purchase_status: "not_purchased",
      pro_transaction_id: null,
      pro_purchased_at: null,
    };
    return {
      ...base,
      aura_available: barberAuraEffective(base),
      booking_deposit_available: barberDepositsEffective(base),
    };
  }
  const subscription_monthly_price =
    row.subscription_monthly_price != null && Number.isFinite(Number(row.subscription_monthly_price))
      ? Number(row.subscription_monthly_price)
      : null;
  const base = {
    theme_color: String(row.theme_color || "#FFD700"),
    booking_deposit_enabled: Boolean(row.booking_deposit_enabled),
    deposit_amount: Number(row.deposit_amount) || 0,
    payment_method: String(row.payment_method || "paypal"),
    aura_enabled: Boolean(row.aura_enabled),
    aura_voice_type: String(row.aura_voice_type || "Polly.Joanna"),
    language: String(row.language || "en"),
    subscription_tier: normalizeTier(row.subscription_tier),
    subscription_monthly_price,
    billing_provider: normalizeBillingProvider(row.billing_provider),
    billing_subscription_id: row.billing_subscription_id != null ? String(row.billing_subscription_id) : null,
    is_pro: Boolean(row.is_pro),
    pro_purchase_status: String(row.pro_purchase_status || "not_purchased"),
    pro_transaction_id: row.pro_transaction_id != null ? String(row.pro_transaction_id) : null,
    pro_purchased_at: row.pro_purchased_at || null,
  };
  return {
    ...base,
    aura_available: barberAuraEffective(base),
    booking_deposit_available: barberDepositsEffective(base),
  };
}

/**
 * Pricing options for `computeChargeBreakdown` (barber overrides global env when set).
 * @param {number} barberId
 */
export async function loadBarberDepositPricingOpts(barberId) {
  const s = await loadBarberSettingsRow(barberId);
  const subscriptionTier = s.subscription_tier;
  const platformFeeUsd = platformFeeUsdForTier(subscriptionTier);
  const common = { subscriptionTier, platformFeeUsd };
  return { ...common, barberDepositEnabled: false, barberDepositAmount: undefined };
}

/**
 * Links a booking to `barber_clients` (creates a lightweight CRM row when missing).
 * @returns {Promise<number | null>}
 */
export async function resolveOrCreateBarberClientId(barberId, customerName, customerEmail) {
  const { coerceBarberIdForTable } = await import("./barberIdentity.cjs");
  const bid = await coerceBarberIdForTable(dbQuery, "barber_clients", barberId);
  const em = String(customerEmail || "").trim();
  const nm = String(customerName || "").trim();
  if (bid == null || !em) return null;

  const found = await dbQuery(
    `SELECT id FROM barber_clients
     WHERE barber_id = $1 AND lower(trim(COALESCE(email, ''))) = lower(trim($2))
     LIMIT 1`,
    [bid, em],
  );
  const existingId = found.rows?.[0]?.id;
  if (existingId != null) return Number(existingId);

  const ins = await dbQuery(
    `INSERT INTO barber_clients (barber_id, name, email, phone, notes)
     VALUES ($1, $2, $3, NULL, $4)
     RETURNING id`,
    [bid, nm || "Client", em, "from booking"],
  );
  const id = ins.rows?.[0]?.id;
  return id != null ? Number(id) : null;
}

/**
 * Public booking UI + PayPal alignment (no auth).
 * @param {number} barberId
 */
export async function buildPublicBarberPricingResponse(barberId) {
  const bid = String(barberId ?? "").trim();
  if (!bid) return null;

  const settings = await loadBarberSettingsRow(bid);
  const depositOpts = await loadBarberDepositPricingOpts(bid);
  const deposits_allowed = false;
  const platform_fee_usd = Number(depositOpts.platformFeeUsd) || 0;
  const barber_platform_fee_per_booking_usd = 0.99;

  const svc = await dbQuery(
    `SELECT id, name, description, icon, price::float8 AS price, duration_minutes, is_active
     FROM barber_services
     WHERE barber_id::text = $1::text AND is_active = true
     ORDER BY id ASC
     LIMIT 100`,
    [bid],
  );

  return {
    barberId: bid,
    subscription_tier: settings.subscription_tier,
    platform_fee_usd,
    barber_platform_fee_per_booking_usd,
    free_tier_upgrade_message:
      settings.subscription_tier === TIER_FREE
        ? "Optional Pro upgrade ($9.99) unlocks more dashboard and AURA tools."
        : null,
    aura_available: settings.aura_available,
    booking_deposit_enabled: false,
    booking_deposit_available: false,
    deposit_amount: 0,
    deposits_allowed: false,
    payment_method: settings.payment_method,
    theme_color: settings.theme_color,
    services: svc.rows || [],
  };
}
