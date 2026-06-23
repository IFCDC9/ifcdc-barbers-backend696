/**
 * Shop access gates — bookings, payments, and approval workflow.
 */
import { dbQuery } from "./db.js";

export async function loadShopAccessRow(businessId) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid)) return null;
  const r = await dbQuery(
    `SELECT id, name, plan, subscription_status, account_status, approval_status, access_plan,
            free_access_enabled, paid_subscription_required, bookings_enabled, payment_processing_enabled,
            trial_started_at, trial_ends_at, monthly_price
     FROM businesses WHERE id = $1::bigint LIMIT 1`,
    [bid],
  );
  return r.rows?.[0] || null;
}

/** Apply trial expiry and subscription rules to effective access flags. */
export function effectiveShopAccess(row) {
  if (!row) {
    return {
      approved: false,
      bookingsEnabled: false,
      paymentProcessingEnabled: false,
      limitedAccess: true,
      reason: "shop_not_found",
    };
  }

  const approval = String(row.approval_status || "pending").toLowerCase();
  const account = String(row.account_status || "active").toLowerCase();
  const accessPlan = String(row.access_plan || row.plan || "pending").toLowerCase();
  const sub = String(row.subscription_status || "inactive").toLowerCase();

  if (approval === "rejected") {
    return {
      approved: false,
      bookingsEnabled: false,
      paymentProcessingEnabled: false,
      limitedAccess: true,
      reason: "shop_rejected",
    };
  }

  if (approval !== "approved") {
    return {
      approved: false,
      bookingsEnabled: false,
      paymentProcessingEnabled: false,
      limitedAccess: true,
      reason: "pending_approval",
    };
  }

  if (account === "suspended" || account === "disabled") {
    return {
      approved: true,
      bookingsEnabled: false,
      paymentProcessingEnabled: false,
      limitedAccess: true,
      reason: "shop_suspended",
    };
  }

  let bookingsEnabled = row.bookings_enabled !== false;
  let paymentProcessingEnabled = row.payment_processing_enabled !== false;

  if (accessPlan === "trial") {
    const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    if (ends && ends < Date.now()) {
      bookingsEnabled = false;
      paymentProcessingEnabled = false;
      return {
        approved: true,
        bookingsEnabled: false,
        paymentProcessingEnabled: false,
        limitedAccess: true,
        reason: "trial_expired",
        trialExpired: true,
      };
    }
  }

  if (accessPlan === "paid" && row.paid_subscription_required !== false && sub !== "active") {
    bookingsEnabled = false;
    paymentProcessingEnabled = false;
    return {
      approved: true,
      bookingsEnabled: false,
      paymentProcessingEnabled: false,
      limitedAccess: true,
      reason: "subscription_inactive",
    };
  }

  if (accessPlan === "free" && row.free_access_enabled === false) {
    bookingsEnabled = bookingsEnabled && row.free_access_enabled === true;
  }

  return {
    approved: true,
    bookingsEnabled: Boolean(bookingsEnabled),
    paymentProcessingEnabled: Boolean(paymentProcessingEnabled),
    limitedAccess: !bookingsEnabled,
    reason: bookingsEnabled ? null : "bookings_disabled",
    accessPlan,
  };
}

export async function getShopAccess(businessId) {
  const row = await loadShopAccessRow(businessId);
  return { row, ...effectiveShopAccess(row) };
}

export async function assertShopCanAcceptBookings(businessId) {
  const access = await getShopAccess(businessId);
  if (!access.bookingsEnabled) {
    const messages = {
      pending_approval: "This shop is awaiting platform approval. Booking is not available yet.",
      shop_rejected: "This shop registration was not approved.",
      shop_suspended: "This shop is suspended. Booking is temporarily unavailable.",
      trial_expired: "This shop's trial has ended. A paid subscription is required to accept bookings.",
      subscription_inactive: "This shop's subscription is inactive. Booking is disabled until payment is restored.",
      bookings_disabled: "Booking is disabled for this shop.",
      shop_not_found: "Shop not found.",
    };
    return {
      ok: false,
      code: access.reason || "shop_access_denied",
      message: messages[access.reason] || "Booking is not available for this shop.",
    };
  }
  return { ok: true, access };
}

export async function assertShopCanProcessPayments(businessId) {
  const access = await getShopAccess(businessId);
  if (!access.paymentProcessingEnabled) {
    return {
      ok: false,
      code: "payments_disabled",
      message: "Online payment processing is disabled for this shop.",
    };
  }
  return { ok: true, access };
}

export async function resolveBusinessIdForBarber(dbQueryFn, barberDbId) {
  const r = await dbQueryFn(`SELECT business_id FROM barbers WHERE id::text = $1 LIMIT 1`, [
    String(barberDbId),
  ]);
  const bid = r.rows?.[0]?.business_id;
  return bid != null && bid !== "" ? Number(bid) : null;
}
