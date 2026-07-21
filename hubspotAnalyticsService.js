/**
 * Phase 2D — IFCDC HQ analytics for HubSpot + local CRM metrics.
 * Aggregates Postgres (bookings, customers, loyalty) + hubspot_sync_* mapping health.
 * Never calls HubSpot with secrets in responses; never blocks booking/payment paths.
 */
import { dbQuery } from "./db.js";
import {
  isHubSpotCanonicalRuntime,
  isHubSpotCompanySyncEnabled,
  isHubSpotConfigured,
  isHubSpotDealSyncEnabled,
  isHubSpotSyncEnabled,
  isHubSpotWorkflowSyncEnabled,
} from "./hubspotService.js";

function envFlag(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Phase 2D — HQ analytics API (requires master HubSpot sync flag + canonical runtime). */
export function isHubSpotHqAnalyticsEnabled() {
  return isHubSpotSyncEnabled() && envFlag("HUBSPOT_HQ_ANALYTICS");
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function paidPredicate(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `(
    ${p}is_paid_booking = true
    OR lower(coalesce(${p}payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'captured', 'deposit_paid')
  )`;
}

/**
 * Build HQ KPI payload for admin dashboards.
 * @param {{ days?: number }} options
 */
export async function getHubSpotHqKpis({ days = 30 } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || 30, 7), 365);
  const enabled = isHubSpotHqAnalyticsEnabled();

  const flags = {
    configured: isHubSpotConfigured(),
    syncEnabled: isHubSpotSyncEnabled(),
    companySyncEnabled: isHubSpotCompanySyncEnabled(),
    dealSyncEnabled: isHubSpotDealSyncEnabled(),
    workflowSyncEnabled: isHubSpotWorkflowSyncEnabled(),
    analyticsEnabled: enabled,
    canonicalRuntime: isHubSpotCanonicalRuntime(),
  };

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      windowDays,
      flags,
      message:
        "Set HUBSPOT_HQ_ANALYTICS=1 (with HUBSPOT_SYNC_ENABLED=1) on the canonical Render service to enable HQ analytics.",
    };
  }

  const out = {
    ok: true,
    enabled: true,
    windowDays,
    flags,
    generatedAt: new Date().toISOString(),
    customerGrowth: null,
    returningCustomerRate: null,
    appointmentVolume: null,
    revenueTrends: null,
    topBarbers: [],
    topShops: [],
    customerLifetimeValue: [],
    marketingCampaignPerformance: null,
    hubspotSyncHealth: null,
  };

  // --- Customer growth ---
  try {
    const growth = await dbQuery(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day'))::int AS new_customers,
         COUNT(*)::int AS total_customers,
         COUNT(*) FILTER (
           WHERE created_at >= NOW() - ($1::int * INTERVAL '2 day')
             AND created_at < NOW() - ($1::int * INTERVAL '1 day')
         )::int AS previous_period_customers
       FROM app_users
       WHERE lower(coalesce(role, 'user')) NOT IN ('super_admin', 'admin', 'shop_owner', 'barber')`,
      [windowDays],
    );
    const g = growth.rows?.[0] || {};
    const neu = num(g.new_customers);
    const prev = num(g.previous_period_customers);
    out.customerGrowth = {
      newCustomers: neu,
      totalCustomers: num(g.total_customers),
      previousPeriodCustomers: prev,
      growthRate:
        prev > 0 ? Number((((neu - prev) / prev) * 100).toFixed(1)) : neu > 0 ? 100 : 0,
    };
  } catch (e) {
    out.customerGrowth = { error: "unavailable", detail: String(e?.message || e).slice(0, 120) };
  }

  // --- Returning customer rate ---
  try {
    const ret = await dbQuery(
      `WITH cust AS (
         SELECT COALESCE(user_id::text, lower(nullif(trim(customer_email), ''))) AS cid,
                COUNT(*)::int AS visits
         FROM bookings
         WHERE deleted_at IS NULL
           AND COALESCE(user_id::text, lower(nullif(trim(customer_email), ''))) IS NOT NULL
           AND (
             lower(coalesce(booking_status, '')) IN ('completed', 'confirmed')
             OR ${paidPredicate()}
           )
           AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         GROUP BY 1
       )
       SELECT
         COUNT(*)::int AS customers,
         COUNT(*) FILTER (WHERE visits >= 2)::int AS returning_customers,
         COALESCE(AVG(visits), 0)::float8 AS avg_visits
       FROM cust`,
      [windowDays],
    );
    const r = ret.rows?.[0] || {};
    const customers = num(r.customers);
    const returning = num(r.returning_customers);
    out.returningCustomerRate = {
      customers,
      returningCustomers: returning,
      ratePercent: customers > 0 ? Number(((returning / customers) * 100).toFixed(1)) : 0,
      avgVisits: Number(num(r.avg_visits).toFixed(2)),
    };
  } catch (e) {
    out.returningCustomerRate = { error: "unavailable", detail: String(e?.message || e).slice(0, 120) };
  }

  // --- Appointment volume (by day) ---
  try {
    const vol = await dbQuery(
      `SELECT
         to_char(date_trunc('day', coalesce(completed_at, created_at)), 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS appointments,
         COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid,
         COUNT(*) FILTER (WHERE lower(coalesce(booking_status, '')) = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE lower(coalesce(booking_status, '')) = 'cancelled')::int AS cancelled
       FROM bookings
       WHERE deleted_at IS NULL
         AND coalesce(completed_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY 1
       ORDER BY 1 ASC`,
      [windowDays],
    );
    const totals = await dbQuery(
      `SELECT
         COUNT(*)::int AS appointments,
         COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid,
         COUNT(*) FILTER (WHERE lower(coalesce(booking_status, '')) = 'completed')::int AS completed
       FROM bookings
       WHERE deleted_at IS NULL
         AND coalesce(completed_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day')`,
      [windowDays],
    );
    out.appointmentVolume = {
      totals: totals.rows?.[0] || { appointments: 0, paid: 0, completed: 0 },
      series: (vol.rows || []).map((row) => ({
        day: row.day,
        appointments: num(row.appointments),
        paid: num(row.paid),
        completed: num(row.completed),
        cancelled: num(row.cancelled),
      })),
    };
  } catch (e) {
    // deleted_at may not exist on older schemas
    try {
      const vol = await dbQuery(
        `SELECT
           to_char(date_trunc('day', coalesce(completed_at, created_at)), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS appointments,
           COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid,
           COUNT(*) FILTER (WHERE lower(coalesce(booking_status, '')) = 'completed')::int AS completed
         FROM bookings
         WHERE coalesce(completed_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day')
         GROUP BY 1
         ORDER BY 1 ASC`,
        [windowDays],
      );
      out.appointmentVolume = {
        totals: {
          appointments: (vol.rows || []).reduce((s, r) => s + num(r.appointments), 0),
          paid: (vol.rows || []).reduce((s, r) => s + num(r.paid), 0),
          completed: (vol.rows || []).reduce((s, r) => s + num(r.completed), 0),
        },
        series: (vol.rows || []).map((row) => ({
          day: row.day,
          appointments: num(row.appointments),
          paid: num(row.paid),
          completed: num(row.completed),
        })),
      };
    } catch (e2) {
      out.appointmentVolume = { error: "unavailable", detail: String(e2?.message || e2).slice(0, 120) };
    }
  }

  // --- Revenue trends (by week) ---
  try {
    const rev = await dbQuery(
      `SELECT
         to_char(date_trunc('week', coalesce(completed_at, created_at)), 'YYYY-MM-DD') AS week_start,
         COALESCE(SUM(
           CASE WHEN ${paidPredicate()}
             THEN COALESCE(total_paid, amount_paid, amount_charged, total_price, amount, 0)
             ELSE 0 END
         ), 0)::float8 AS revenue,
         COALESCE(SUM(COALESCE(platform_fee, 0)), 0)::float8 AS platform_fees,
         COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid_bookings
       FROM bookings
       WHERE coalesce(completed_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY 1
       ORDER BY 1 ASC`,
      [windowDays],
    );
    const sum = (rev.rows || []).reduce(
      (acc, row) => {
        acc.revenue += num(row.revenue);
        acc.platformFees += num(row.platform_fees);
        acc.paidBookings += num(row.paid_bookings);
        return acc;
      },
      { revenue: 0, platformFees: 0, paidBookings: 0 },
    );
    out.revenueTrends = {
      totals: {
        revenue: Number(sum.revenue.toFixed(2)),
        platformFees: Number(sum.platformFees.toFixed(2)),
        paidBookings: sum.paidBookings,
      },
      series: (rev.rows || []).map((row) => ({
        weekStart: row.week_start,
        revenue: Number(num(row.revenue).toFixed(2)),
        platformFees: Number(num(row.platform_fees).toFixed(2)),
        paidBookings: num(row.paid_bookings),
      })),
    };
  } catch (e) {
    out.revenueTrends = { error: "unavailable", detail: String(e?.message || e).slice(0, 120) };
  }

  // --- Top barbers ---
  try {
    const topB = await dbQuery(
      `SELECT
         barber_id,
         COALESCE(nullif(trim(barber_name), ''), 'Barber ' || coalesce(barber_id::text, '?')) AS name,
         COUNT(*)::int AS appointments,
         COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid_appointments,
         COALESCE(SUM(
           CASE WHEN ${paidPredicate()}
             THEN COALESCE(total_paid, amount_paid, amount_charged, total_price, amount, 0)
             ELSE 0 END
         ), 0)::float8 AS revenue
       FROM bookings
       WHERE coalesce(completed_at, created_at) >= NOW() - ($1::int * INTERVAL '1 day')
         AND barber_id IS NOT NULL
       GROUP BY barber_id, 2
       ORDER BY revenue DESC, paid_appointments DESC
       LIMIT 10`,
      [windowDays],
    );
    out.topBarbers = (topB.rows || []).map((row) => ({
      barberId: row.barber_id,
      name: row.name,
      appointments: num(row.appointments),
      paidAppointments: num(row.paid_appointments),
      revenue: Number(num(row.revenue).toFixed(2)),
    }));
  } catch (e) {
    out.topBarbers = [];
    out.topBarbersError = String(e?.message || e).slice(0, 120);
  }

  // --- Top shops ---
  try {
    const topS = await dbQuery(
      `SELECT
         b.business_id,
         COALESCE(nullif(trim(biz.name), ''), 'Shop ' || b.business_id::text) AS name,
         COUNT(*)::int AS appointments,
         COUNT(*) FILTER (WHERE ${paidPredicate("b")})::int AS paid_appointments,
         COALESCE(SUM(
           CASE WHEN ${paidPredicate("b")}
             THEN COALESCE(b.total_paid, b.amount_paid, b.amount_charged, b.total_price, b.amount, 0)
             ELSE 0 END
         ), 0)::float8 AS revenue,
         COALESCE(SUM(COALESCE(b.platform_fee, 0)), 0)::float8 AS platform_fees
       FROM bookings b
       LEFT JOIN businesses biz ON biz.id = b.business_id
       WHERE coalesce(b.completed_at, b.created_at) >= NOW() - ($1::int * INTERVAL '1 day')
         AND b.business_id IS NOT NULL
       GROUP BY b.business_id, 2
       ORDER BY revenue DESC, paid_appointments DESC
       LIMIT 10`,
      [windowDays],
    );
    out.topShops = (topS.rows || []).map((row) => ({
      businessId: row.business_id,
      name: row.name,
      appointments: num(row.appointments),
      paidAppointments: num(row.paid_appointments),
      revenue: Number(num(row.revenue).toFixed(2)),
      platformFees: Number(num(row.platform_fees).toFixed(2)),
    }));
  } catch (e) {
    out.topShops = [];
    out.topShopsError = String(e?.message || e).slice(0, 120);
  }

  // --- Customer lifetime value (top spenders) ---
  try {
    const clv = await dbQuery(
      `SELECT
         COALESCE(user_id::text, lower(nullif(trim(customer_email), ''))) AS customer_key,
         MAX(nullif(trim(customer_name), '')) AS name,
         MAX(nullif(trim(customer_email), '')) AS email,
         COUNT(*) FILTER (WHERE ${paidPredicate()})::int AS paid_visits,
         COALESCE(SUM(
           CASE WHEN ${paidPredicate()}
             THEN COALESCE(total_paid, amount_paid, amount_charged, total_price, amount, 0)
             ELSE 0 END
         ), 0)::float8 AS lifetime_value
       FROM bookings
       WHERE COALESCE(user_id::text, lower(nullif(trim(customer_email), ''))) IS NOT NULL
       GROUP BY 1
       HAVING COALESCE(SUM(
         CASE WHEN ${paidPredicate()}
           THEN COALESCE(total_paid, amount_paid, amount_charged, total_price, amount, 0)
           ELSE 0 END
       ), 0) > 0
       ORDER BY lifetime_value DESC
       LIMIT 10`,
    );
    out.customerLifetimeValue = (clv.rows || []).map((row) => ({
      customerKey: row.customer_key,
      name: row.name || null,
      email: row.email
        ? String(row.email).replace(/^(.{2}).+(@.+)$/, "$1***$2")
        : null,
      paidVisits: num(row.paid_visits),
      lifetimeValue: Number(num(row.lifetime_value).toFixed(2)),
    }));
  } catch (e) {
    out.customerLifetimeValue = [];
    out.customerLifetimeValueError = String(e?.message || e).slice(0, 120);
  }

  // --- Marketing campaign performance (local loyalty campaigns + HubSpot workflow events) ---
  try {
    const campaigns = await dbQuery(
      `SELECT
         COUNT(*)::int AS active_campaigns,
         COALESCE(SUM(CASE WHEN lower(coalesce(status, 'active')) = 'active' THEN 1 ELSE 0 END), 0)::int AS currently_active
       FROM loyalty_campaigns`,
    ).catch(() => ({ rows: [{ active_campaigns: 0, currently_active: 0 }] }));

    const earnWithCampaign = await dbQuery(
      `SELECT COUNT(*)::int AS earn_events,
              COALESCE(SUM(delta), 0)::int AS points_awarded
       FROM loyalty_transactions
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
         AND transaction_type = 'earn'`,
      [windowDays],
    ).catch(() => ({ rows: [{ earn_events: 0, points_awarded: 0 }] }));

    const workflowEvents = await dbQuery(
      `SELECT
         COUNT(*) FILTER (WHERE message ILIKE '%register%' OR message ILIKE '%welcome%' OR action ILIKE '%register%')::int AS welcome_signals,
         COUNT(*) FILTER (WHERE message ILIKE '%completed%' OR message ILIKE '%review%')::int AS review_signals,
         COUNT(*) FILTER (WHERE entity_type = 'deal' AND status = 'ok')::int AS deal_sync_ok,
         COUNT(*) FILTER (WHERE entity_type = 'contact' AND status = 'ok')::int AS contact_sync_ok,
         COUNT(*)::int AS total_events
       FROM hubspot_sync_events
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [windowDays],
    ).catch(() => ({ rows: [{}] }));

    const c = campaigns.rows?.[0] || {};
    const e = earnWithCampaign.rows?.[0] || {};
    const w = workflowEvents.rows?.[0] || {};
    out.marketingCampaignPerformance = {
      source: "loyalty_campaigns_and_hubspot_sync_events",
      note:
        "HubSpot Marketing campaign open/click rates are managed in HubSpot. This view shows local loyalty campaign activity and HubSpot sync enrollment signals.",
      loyaltyCampaigns: {
        total: num(c.active_campaigns),
        active: num(c.currently_active),
      },
      loyaltyEarn: {
        events: num(e.earn_events),
        pointsAwarded: num(e.points_awarded),
      },
      hubspotWorkflowSignals: {
        welcomeSignals: num(w.welcome_signals),
        reviewSignals: num(w.review_signals),
        dealSyncOk: num(w.deal_sync_ok),
        contactSyncOk: num(w.contact_sync_ok),
        totalEvents: num(w.total_events),
      },
    };
  } catch (e) {
    out.marketingCampaignPerformance = {
      error: "unavailable",
      detail: String(e?.message || e).slice(0, 120),
    };
  }

  // --- HubSpot sync health ---
  try {
    const [contacts, companies, deals, recentErrors] = await Promise.all([
      dbQuery(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE last_sync_status = 'synced')::int AS synced,
           COUNT(*) FILTER (WHERE last_sync_status = 'error')::int AS errors
         FROM hubspot_sync_contacts`,
      ).catch(() => ({ rows: [{}] })),
      dbQuery(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE last_sync_status = 'synced')::int AS synced,
           COUNT(*) FILTER (WHERE last_sync_status = 'error')::int AS errors
         FROM hubspot_sync_companies`,
      ).catch(() => ({ rows: [{}] })),
      dbQuery(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE last_sync_status = 'synced')::int AS synced,
           COUNT(*) FILTER (WHERE last_sync_status = 'error')::int AS errors
         FROM hubspot_sync_deals`,
      ).catch(() => ({ rows: [{}] })),
      dbQuery(
        `SELECT entity_type, action, status, left(coalesce(message, ''), 80) AS message, created_at
         FROM hubspot_sync_events
         WHERE status = 'error'
         ORDER BY created_at DESC
         LIMIT 5`,
      ).catch(() => ({ rows: [] })),
    ]);
    out.hubspotSyncHealth = {
      contacts: contacts.rows?.[0] || { total: 0, synced: 0, errors: 0 },
      companies: companies.rows?.[0] || { total: 0, synced: 0, errors: 0 },
      deals: deals.rows?.[0] || { total: 0, synced: 0, errors: 0 },
      recentErrors: (recentErrors.rows || []).map((row) => ({
        entityType: row.entity_type,
        action: row.action,
        status: row.status,
        message: row.message,
        createdAt: row.created_at,
      })),
    };
  } catch (e) {
    out.hubspotSyncHealth = { error: "unavailable", detail: String(e?.message || e).slice(0, 120) };
  }

  return out;
}
