/**
 * Server-side entitlements. Frontend status is never trusted.
 * Role ≠ subscription. Shop/multi-location plans inherit to staff by shop permission, not by role name.
 */

import { dbQuery as defaultDbQuery } from "./db.js";
import { entitlementsLockShopsEnabled, entitlementsMode } from "./entitlementFlags.js";
import {
  BARBER_PLATFORM_FEE_USD,
} from "./subscriptionTier.js";
import { PLAN_RANK, catalogPublic, higherPlan, googleAccessProductId, APPLE_PRODUCTS, GOOGLE_SUB_PRODUCTS } from "./monetizationCatalog.js";
import { loadActiveManagementContext } from "./managementTeamAuth.js";
import { SUPER_ADMIN_ONLY_CAPABILITIES } from "./managementPermissions.js";

const ACTIVE_SUB_STATUSES = new Set(["trial", "active", "grace", "billing_retry"]);

function isSubLive(row, now = Date.now()) {
  if (!row) return false;
  const st = String(row.status || "").toLowerCase();
  if (!ACTIVE_SUB_STATUSES.has(st)) return false;
  if (st === "trial") {
    const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    return !ends || ends > now;
  }
  const periodEnd = row.current_period_end ? new Date(row.current_period_end).getTime() : 0;
  if (periodEnd && periodEnd < now && st !== "grace" && st !== "billing_retry") return false;
  return true;
}

export function mapAppleNotificationToStatus(notificationType, subtype) {
  const t = String(notificationType || "").toUpperCase();
  const s = String(subtype || "").toUpperCase();
  if (t === "EXPIRED" || t === "GRACE_PERIOD_EXPIRED" || t === "REVOKE" || t === "REFUND") return "expired";
  if (t === "GRACE_PERIOD" || (t === "DID_FAIL_TO_RENEW" && s === "GRACE_PERIOD")) return "grace";
  if (t === "DID_FAIL_TO_RENEW") return "billing_retry";
  if (t === "DID_CHANGE_RENEWAL_STATUS" && s === "AUTO_RENEW_DISABLED") {
    return { status: "active", cancelAtPeriodEnd: true, autoRenew: false };
  }
  if (t === "DID_CHANGE_RENEWAL_STATUS") return "active";
  if (t === "DID_CHANGE_RENEWAL_PREF") return "active";
  if (["SUBSCRIBED", "DID_RENEW", "OFFER_REDEEMED", "RENEWAL_EXTENDED"].includes(t)) return "active";
  return "active";
}

export function mapGoogleSubscriptionState(state) {
  const n = Number(state);
  // 1=ACTIVE 2=CANCELLED still entitled until expiry handled by expiry time
  if (n === 1) return "active";
  if (n === 2) return { status: "active", cancelAtPeriodEnd: true, autoRenew: false };
  if (n === 3) return "grace"; // in grace
  if (n === 4) return "paused";
  if (n === 5) return "paused"; // on hold
  if (n === 6) return "expired"; // paused? 
  if (n === 0) return "expired";
  return "active";
}

export function mapGoogleRtdnType(type) {
  const t = Number(type);
  const map = {
    1: "SUBSCRIPTION_RECOVERED",
    2: "SUBSCRIPTION_RENEWED",
    3: "SUBSCRIPTION_CANCELED",
    4: "SUBSCRIPTION_PURCHASED",
    5: "SUBSCRIPTION_ON_HOLD",
    6: "SUBSCRIPTION_IN_GRACE_PERIOD",
    7: "SUBSCRIPTION_RESTARTED",
    12: "SUBSCRIPTION_REVOKED",
    13: "SUBSCRIPTION_EXPIRED",
  };
  return map[t] || `google_rtdn_${t}`;
}

/**
 * @param {object} opts
 * @param {object[]} opts.ownSubs
 * @param {object[]} opts.businessSubs
 * @param {number[]} opts.staffShopIds shops the user may operate via management assignment or business_id
 * @param {object[]} opts.appAccessRows
 */
export function resolveEntitlementsSnapshot({
  userId,
  role,
  ownSubs = [],
  businessSubs = [],
  staffShopIds = [],
  appAccessRows = [],
  now = Date.now(),
} = {}) {
  const roleName = String(role || "user").toLowerCase();
  let bestPlan = null;
  let bestRow = null;
  const liveOwn = [];

  for (const row of ownSubs) {
    if (!isSubLive(row, now)) continue;
    liveOwn.push(row);
    if (!bestPlan || (PLAN_RANK[row.plan_key] || 0) > (PLAN_RANK[bestPlan] || 0)) {
      bestPlan = row.plan_key;
      bestRow = row;
    }
  }

  const inherited = [];
  const allowedShops = new Set((staffShopIds || []).map(Number).filter(Number.isFinite));
  for (const row of businessSubs) {
    const bid = Number(row.business_id);
    if (!allowedShops.has(bid)) continue;
    if (!isSubLive(row, now)) continue;
    inherited.push({
      businessId: bid,
      planKey: row.plan_key,
      status: row.status,
      source: row.source,
    });
    const next = higherPlan(bestPlan, row.plan_key);
    if (next !== bestPlan) {
      bestPlan = next;
      bestRow = row;
    }
  }

  const appAccessGranted = (appAccessRows || []).some((r) => String(r.status || "").toLowerCase() === "granted");

  return {
    userId: userId || null,
    role: roleName,
    roleIsNotSubscription: true,
    planKey: bestPlan,
    planRank: PLAN_RANK[bestPlan] || 0,
    subscriptionStatus: bestRow ? bestRow.status : "none",
    inheritedFromBusiness: inherited,
    appAccess: {
      granted: appAccessGranted,
      productId: googleAccessProductId(),
      separateFromSubscription: true,
    },
    bookingPlatformFeeUsd: BARBER_PLATFORM_FEE_USD,
    fieldsAreSeparate: true,
    managersCannotReceive: SUPER_ADMIN_ONLY_CAPABILITIES.concat(["complimentary_subscription", "global_subscription_pricing"]),
    sourceRowId: bestRow?.id || null,
    mode: entitlementsMode(),
    lockShops: entitlementsLockShopsEnabled(),
  };
}

export async function loadEntitlementsForUser(user, { dbQuery = defaultDbQuery } = {}) {
  const userId = user?.id || user?.sub;
  if (!userId) {
    return resolveEntitlementsSnapshot({ userId: null, role: "anonymous" });
  }

  const [own, access] = await Promise.all([
    dbQuery(
      `SELECT * FROM account_subscriptions WHERE user_id = $1::uuid ORDER BY updated_at DESC`,
      [String(userId)],
    ).catch(() => ({ rows: [] })),
    dbQuery(
      `SELECT * FROM app_access_entitlements WHERE user_id = $1::uuid ORDER BY updated_at DESC`,
      [String(userId)],
    ).catch(() => ({ rows: [] })),
  ]);

  let staffShopIds = [];
  const biz = Number(user.businessId ?? user.business_id);
  if (Number.isFinite(biz)) staffShopIds.push(biz);

  try {
    const mgmt = await loadActiveManagementContext(userId);
    if (mgmt?.shopIds?.length) staffShopIds = staffShopIds.concat(mgmt.shopIds);
  } catch {
    /* management optional */
  }
  staffShopIds = [...new Set(staffShopIds.map(Number).filter(Number.isFinite))];

  let businessSubs = { rows: [] };
  if (staffShopIds.length) {
    businessSubs = await dbQuery(
      `SELECT * FROM account_subscriptions
       WHERE business_id = ANY($1::bigint[])
         AND plan_key IN ('shop', 'multilocation')
       ORDER BY updated_at DESC`,
      [staffShopIds],
    ).catch(() => ({ rows: [] }));
  }

  const snapshot = resolveEntitlementsSnapshot({
    userId,
    role: user.role,
    ownSubs: own.rows || [],
    businessSubs: businessSubs.rows || [],
    staffShopIds,
    appAccessRows: access.rows || [],
  });

  snapshot.legacyMirror = {
    note: "barber_settings.subscription_tier / businesses.plan / barber_subscriptions are read-only mirrors. They do not grant IAP.",
  };
  snapshot.catalog = catalogPublic();
  snapshot.clientStatusIgnored = true;
  return snapshot;
}

const LIVE_MRR_STATUSES = new Set(["trial", "active", "grace", "billing_retry"]);

function listPriceForPlan(planKey, storePlatform) {
  const apple = APPLE_PRODUCTS[planKey];
  const google = GOOGLE_SUB_PRODUCTS[planKey];
  if (String(storePlatform || "").toLowerCase() === "google") {
    return Number(google?.listPriceUsd || 0);
  }
  return Number(apple?.listPriceUsd || google?.listPriceUsd || 0);
}

/** Production-only MRR. Sandbox / missing environment is excluded (never invented). */
export function productionMrrFromSubscriptions(rows = [], now = Date.now()) {
  let mrr = 0;
  for (const row of rows) {
    const env = String(row.store_environment || "").toLowerCase();
    if (env !== "production") continue;
    const st = String(row.status || "").toLowerCase();
    if (!LIVE_MRR_STATUSES.has(st)) continue;
    if (!isSubLive(row, now)) continue;
    mrr += listPriceForPlan(row.plan_key, row.store_platform);
  }
  return Math.round(mrr * 100) / 100;
}

export async function recordSubscriptionEvent(dbQuery, row) {
  const r = await dbQuery(
    `INSERT INTO subscription_events
      (account_subscription_id, user_id, business_id, provider, event_type, notification_uuid, payload, processed)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (provider, notification_uuid)
     WHERE notification_uuid IS NOT NULL AND btrim(notification_uuid) <> ''
     DO NOTHING
     RETURNING id`,
    [
      row.accountSubscriptionId || null,
      row.userId || null,
      row.businessId || null,
      row.provider,
      row.eventType,
      row.notificationUuid || null,
      JSON.stringify(row.payload || {}),
      row.processed === true,
    ],
  );
  return r.rows?.[0] || null;
}

/**
 * Upsert from a verified store transaction. Never deletes historical rows.
 */
export async function upsertVerifiedSubscription(dbQuery, verified) {
  const {
    userId = null,
    businessId = null,
    planKey,
    source,
    status,
    storePlatform,
    storeProductId,
    originalTransactionId,
    purchaseToken = null,
    environment = null,
    currentPeriodStart = null,
    currentPeriodEnd = null,
    trialStartedAt = null,
    trialEndsAt = null,
    autoRenew = true,
    cancelAtPeriodEnd = false,
    introUsed = false,
    metadata = {},
  } = verified;

  if (!planKey || !storePlatform) throw new Error("invalid_verified_subscription");

  const r = await dbQuery(
    `INSERT INTO account_subscriptions (
        user_id, business_id, plan_key, source, status,
        store_platform, store_product_id, store_original_transaction_id, store_purchase_token,
        store_environment, auto_renew, cancel_at_period_end, intro_used,
        current_period_start, current_period_end, trial_started_at, trial_ends_at, metadata, updated_at
     ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17, $18::jsonb, NOW()
     )
     ON CONFLICT (store_platform, store_original_transaction_id)
     WHERE store_original_transaction_id IS NOT NULL AND btrim(store_original_transaction_id) <> ''
     DO UPDATE SET
        user_id = COALESCE(EXCLUDED.user_id, account_subscriptions.user_id),
        business_id = COALESCE(EXCLUDED.business_id, account_subscriptions.business_id),
        plan_key = EXCLUDED.plan_key,
        source = EXCLUDED.source,
        status = EXCLUDED.status,
        store_product_id = EXCLUDED.store_product_id,
        store_purchase_token = COALESCE(EXCLUDED.store_purchase_token, account_subscriptions.store_purchase_token),
        store_environment = COALESCE(EXCLUDED.store_environment, account_subscriptions.store_environment),
        auto_renew = EXCLUDED.auto_renew,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        intro_used = account_subscriptions.intro_used OR EXCLUDED.intro_used,
        current_period_start = COALESCE(EXCLUDED.current_period_start, account_subscriptions.current_period_start),
        current_period_end = EXCLUDED.current_period_end,
        trial_started_at = COALESCE(account_subscriptions.trial_started_at, EXCLUDED.trial_started_at),
        trial_ends_at = COALESCE(EXCLUDED.trial_ends_at, account_subscriptions.trial_ends_at),
        metadata = account_subscriptions.metadata || EXCLUDED.metadata,
        updated_at = NOW()
     RETURNING *`,
    [
      userId,
      businessId,
      planKey,
      source,
      status,
      storePlatform,
      storeProductId,
      originalTransactionId,
      purchaseToken,
      environment,
      autoRenew,
      cancelAtPeriodEnd,
      introUsed,
      currentPeriodStart,
      currentPeriodEnd,
      trialStartedAt,
      trialEndsAt,
      JSON.stringify(metadata),
    ],
  );
  return r.rows[0];
}

export async function upsertVerifiedAppAccess(dbQuery, verified) {
  const r = await dbQuery(
    `INSERT INTO app_access_entitlements (
        user_id, platform, product_id, status, store_purchase_token,
        store_original_transaction_id, store_environment, granted_at, restored_at, metadata, updated_at
     ) VALUES ($1, $2, $3, 'granted', $4, $5, $6, NOW(), $7, $8::jsonb, NOW())
     RETURNING *`,
    [
      verified.userId,
      verified.platform,
      verified.productId,
      verified.purchaseToken || null,
      verified.originalTransactionId || null,
      verified.environment || null,
      verified.restored ? new Date().toISOString() : null,
      JSON.stringify(verified.metadata || {}),
    ],
  );
  return r.rows[0];
}

export async function listSubscriptionsForAdmin(dbQuery) {
  const [subs, access, events] = await Promise.all([
    dbQuery(
      `SELECT * FROM account_subscriptions ORDER BY updated_at DESC NULLS LAST LIMIT 500`,
    ),
    dbQuery(
      `SELECT * FROM app_access_entitlements ORDER BY updated_at DESC NULLS LAST LIMIT 500`,
    ),
    dbQuery(
      `SELECT id, provider, event_type, notification_uuid, processed, created_at, user_id, business_id
       FROM subscription_events ORDER BY created_at DESC LIMIT 200`,
    ),
  ]);
  return {
    mode: entitlementsMode(),
    catalog: catalogPublic(),
    subscriptions: subs.rows || [],
    appAccess: access.rows || [],
    recentEvents: events.rows || [],
    bookingPlatformFeeUsd: BARBER_PLATFORM_FEE_USD,
    productionMrrUsd: productionMrrFromSubscriptions(subs.rows || []),
    sandboxExcludedFromMrr: true,
    legacyTablesPreserved: ["barber_subscriptions", "barber_settings.is_pro", "businesses.trial_*"],
  };
}
