/**
 * Phase 3C metric formulas (pure + SQL gatherers).
 * Revenue never includes unpaid/failed/cancelled/test/bypass unless labeled separately.
 */

const { controlledTestSql, isControlledTestBooking } = require("./auraOperationalInsightsSecurity.cjs");

const PAID_STATUSES = new Set(["paid", "captured", "completed", "succeeded"]);
const CANCEL_STATUSES = new Set(["cancelled", "canceled"]);
const NOSHOW_STATUSES = new Set(["no_show", "noshow"]);
const COMPLETED_STATUSES = new Set(["completed"]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function statusOf(row) {
  return String(row.booking_status || row.bookingStatus || "").toLowerCase();
}

function paymentStatusOf(row) {
  return String(row.payment_status || row.paymentStatus || "").toLowerCase();
}

function isRevenueEligible(row) {
  if (isControlledTestBooking(row)) return false;
  if (CANCEL_STATUSES.has(statusOf(row))) return false;
  if (row.refunded_at || row.refundedAt) return false;
  const pay = paymentStatusOf(row);
  if (["unpaid", "failed", "canceled", "cancelled", "pending_payment", "bypass"].includes(pay)) {
    return false;
  }
  const amount = num(row.amount_paid ?? row.amountPaid ?? row.total_paid ?? row.totalPaid ?? 0);
  if (amount <= 0) return false;
  if (PAID_STATUSES.has(pay) || amount > 0) return true;
  return false;
}

function revenueAmount(row) {
  if (!isRevenueEligible(row)) return 0;
  return num(row.amount_paid ?? row.amountPaid ?? row.total_paid ?? row.totalPaid ?? 0);
}

/**
 * Pure booking-performance metrics from an in-memory booking list.
 */
function computeBookingPerformance(bookings = [], { periodStart, periodEnd } = {}) {
  const inPeriod = (b) => {
    const d = String(b.date || "").slice(0, 10);
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    return true;
  };
  const rows = bookings.filter((b) => inPeriod(b) && !isControlledTestBooking(b));
  const excluded = bookings.filter((b) => inPeriod(b) && isControlledTestBooking(b)).length;

  let completed = 0;
  let cancellations = 0;
  let noShows = 0;
  let reschedules = 0;
  let upcoming = 0;
  let advanceHoursSum = 0;
  let advanceCount = 0;

  for (const b of rows) {
    const st = statusOf(b);
    if (COMPLETED_STATUSES.has(st)) completed += 1;
    else if (CANCEL_STATUSES.has(st)) cancellations += 1;
    else if (NOSHOW_STATUSES.has(st)) noShows += 1;
    else upcoming += 1;
    if (b.rescheduled_at || b.rescheduledAt || b.rescheduled_from_date || b.rescheduledFromDate) {
      reschedules += 1;
    }
    const created = b.created_at || b.createdAt;
    const appt = b.date && b.time ? new Date(`${String(b.date).slice(0, 10)}T${String(b.time).slice(0, 8)}`) : null;
    if (created && appt && !Number.isNaN(appt.getTime())) {
      const c = new Date(created);
      if (!Number.isNaN(c.getTime()) && appt > c) {
        advanceHoursSum += (appt - c) / 3600000;
        advanceCount += 1;
      }
    }
  }

  return {
    totalBookings: rows.length,
    completedAppointments: completed,
    cancellations,
    noShows,
    reschedules,
    upcomingOrActive: upcoming,
    controlledTestExcluded: excluded,
    averageAdvanceBookingHours:
      advanceCount > 0 ? Number((advanceHoursSum / advanceCount).toFixed(2)) : null,
    sources: ["bookings"],
  };
}

function computeRevenueOperations(bookings = [], { periodStart, periodEnd } = {}) {
  const inPeriod = (b) => {
    const d = String(b.date || "").slice(0, 10);
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    return true;
  };
  const rows = bookings.filter(inPeriod);
  let paymentsReceived = 0;
  let revenueBookings = 0;
  let failedOrIncomplete = 0;
  const byService = new Map();
  const byBarber = new Map();
  let labeledNonRevenue = 0;

  for (const b of rows) {
    if (isControlledTestBooking(b)) {
      labeledNonRevenue += 1;
      continue;
    }
    const amt = revenueAmount(b);
    if (amt > 0) {
      paymentsReceived += amt;
      revenueBookings += 1;
      const svc = String(b.service || b.service_name || b.serviceName || "unknown");
      const barber = String(b.barber_name || b.barberName || "unknown");
      byService.set(svc, (byService.get(svc) || 0) + amt);
      byBarber.set(barber, (byBarber.get(barber) || 0) + amt);
    } else {
      const pay = paymentStatusOf(b);
      if (["failed", "unpaid", "pending_payment", "bypass"].includes(pay) || CANCEL_STATUSES.has(statusOf(b))) {
        failedOrIncomplete += 1;
      }
    }
  }

  return {
    paymentsReceived: Number(paymentsReceived.toFixed(2)),
    revenueBookingCount: revenueBookings,
    averageBookingValue:
      revenueBookings > 0 ? Number((paymentsReceived / revenueBookings).toFixed(2)) : null,
    failedOrIncompletePayments: failedOrIncomplete,
    controlledOrNonRevenueExcluded: labeledNonRevenue,
    revenueByService: [...byService.entries()]
      .map(([service, revenue]) => ({ service, revenue: Number(revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
    revenueByBarber: [...byBarber.entries()]
      .map(([barber, revenue]) => ({ barber, revenue: Number(revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
    note: "Excludes test, unpaid, failed, cancelled, bypass, and refunded amounts unless listed separately.",
    sources: ["bookings.amount_paid|total_paid", "bookings.payment_status"],
  };
}

function computeServiceDemand(bookings = [], waitlist = [], { periodStart, periodEnd } = {}) {
  const inPeriod = (b) => {
    const d = String(b.date || b.preferred_date || b.preferredDate || "").slice(0, 10);
    if (!d) return true;
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    return true;
  };
  const counts = new Map();
  for (const b of bookings.filter((x) => inPeriod(x) && !isControlledTestBooking(x))) {
    const svc = String(b.service || b.service_name || "unknown");
    counts.set(svc, (counts.get(svc) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .map(([service, requests]) => ({ service, requests }))
    .sort((a, b) => b.requests - a.requests);

  const waitBy = { barber: new Map(), service: new Map(), date: new Map() };
  let waitlistActive = 0;
  for (const w of waitlist) {
    if (String(w.status || "") !== "active") continue;
    if (w.deleted_at || w.deletedAt) continue;
    waitlistActive += 1;
    const barber = String(w.barber_name || w.barberName || (w.any_qualified_barber ? "any_qualified" : "unspecified"));
    const service = String(w.service_name || w.serviceName || "unspecified");
    const date = String(w.preferred_date || w.preferredDate || w.date_from || "flexible").slice(0, 10);
    waitBy.barber.set(barber, (waitBy.barber.get(barber) || 0) + 1);
    waitBy.service.set(service, (waitBy.service.get(service) || 0) + 1);
    waitBy.date.set(date, (waitBy.date.get(date) || 0) + 1);
  }

  return {
    mostRequestedServices: ranked.slice(0, 10),
    waitlistDemand: {
      activeRequests: waitlistActive,
      byBarber: [...waitBy.barber.entries()].map(([k, v]) => ({ barber: k, count: v })),
      byService: [...waitBy.service.entries()].map(([k, v]) => ({ service: k, count: v })),
      byDate: [...waitBy.date.entries()].map(([k, v]) => ({ date: k, count: v })),
    },
    sources: ["bookings.service", "aura_waitlist_requests"],
  };
}

function computeCapacityUtilization(bookings = [], { periodStart, periodEnd, availableSlotMinutes = null } = {}) {
  const rows = bookings.filter((b) => {
    const d = String(b.date || "").slice(0, 10);
    if (periodStart && d < periodStart) return false;
    if (periodEnd && d > periodEnd) return false;
    if (isControlledTestBooking(b)) return false;
    if (CANCEL_STATUSES.has(statusOf(b))) return false;
    return true;
  });

  const byBarber = new Map();
  const byDowHour = new Map();
  let bookedMinutes = 0;

  for (const b of rows) {
    const barber = String(b.barber_name || b.barberName || b.barber_id || "unknown");
    byBarber.set(barber, (byBarber.get(barber) || 0) + 1);
    const dur = num(b.service_duration_minutes || b.serviceDurationMinutes || 30) || 30;
    bookedMinutes += dur;
    const d = new Date(`${String(b.date).slice(0, 10)}T12:00:00Z`);
    const dow = Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
    const hour = String(b.time || "00:00").slice(0, 2);
    const key = `${dow}:${hour}`;
    byDowHour.set(key, (byDowHour.get(key) || 0) + 1);
  }

  const density = [...byDowHour.entries()]
    .map(([key, count]) => {
      const [dow, hour] = key.split(":");
      return { dayOfWeek: Number(dow), hour: `${hour}:00`, appointments: count };
    })
    .sort((a, b) => b.appointments - a.appointments);

  const avg = density.length ? density.reduce((s, x) => s + x.appointments, 0) / density.length : 0;
  const underbooked = density.filter((x) => avg > 0 && x.appointments < avg * 0.5).slice(0, 10);
  const highDemand = density.filter((x) => avg > 0 && x.appointments >= avg * 1.5).slice(0, 10);

  let utilizationPercent = null;
  let utilizationNote = null;
  if (availableSlotMinutes && availableSlotMinutes > 0) {
    utilizationPercent = Number(((bookedMinutes / availableSlotMinutes) * 100).toFixed(1));
  } else {
    utilizationNote = "INSUFFICIENT DATA";
  }

  const barberCounts = [...byBarber.entries()].map(([barber, appointments]) => ({
    barber,
    appointments,
  }));
  // Availability/demand/revenue only — never framed as employee performance score.
  return {
    appointmentsPerBarber: barberCounts.sort((a, b) => b.appointments - a.appointments),
    averageAppointmentsPerBarber:
      barberCounts.length > 0
        ? Number((rows.length / barberCounts.length).toFixed(2))
        : null,
    bookedServiceMinutes: bookedMinutes,
    utilizationPercent,
    utilizationNote,
    underbookedPeriods: underbooked,
    highDemandPeriods: highDemand,
    framing:
      "These figures describe schedule demand and availability only. They are not employee performance scores.",
    sources: ["bookings", "optional barber_availability"],
  };
}

function computeSystemHealth(logs = []) {
  const count = (pred) => logs.filter(pred).length;
  return {
    failedEmails: count(
      (l) =>
        /email|mail|notification/i.test(String(l.action || "")) &&
        /fail/i.test(String(l.result || "") + String(l.action || "")),
    ),
    failedPayments: count(
      (l) => /payment/i.test(String(l.action || "")) && /fail/i.test(String(l.result || "")),
    ),
    bookingConflicts: count((l) => /conflict|duplicate.*slot/i.test(String(l.action || ""))),
    duplicateActionPreventions: count(
      (l) => /duplicate/i.test(String(l.result || "") + String(l.action || "")),
    ),
    waitlistNotificationFailures: count(
      (l) => String(l.action || "") === "waitlist_notification_failed",
    ),
    auraEscalations: count(
      (l) => /escalat/i.test(String(l.action || "")) || String(l.result || "") === "escalated",
    ),
    attentionRequired: count(
      (l) =>
        /fail|attention|escalat/i.test(String(l.result || "")) ||
        l?.metadata?.attentionRequired === true,
    ),
    sources: ["aura_action_logs"],
  };
}

async function gatherBookingRows(dbQuery, { start, end }) {
  const r = await dbQuery(
    `SELECT b.id, b.date::text AS date, to_char(b.time, 'HH24:MI') AS time,
            b.booking_status, b.payment_status, b.service, b.barber_name, b.barber_id,
            b.customer_name, b.customer_email, b.notes,
            b.amount_paid, b.total_paid, b.refunded_at, b.created_at,
            b.rescheduled_at, b.rescheduled_from_date, b.service_duration_minutes
     FROM bookings b
     WHERE b.date BETWEEN $1::date AND $2::date
       AND (b.deleted_at IS NULL)
     ORDER BY b.date ASC
     LIMIT 20000`,
    [start, end],
  ).catch(async () =>
    dbQuery(
      `SELECT b.id, b.date::text AS date, to_char(b.time, 'HH24:MI') AS time,
              b.booking_status, b.payment_status, b.service, b.barber_name, b.barber_id,
              b.customer_name, b.customer_email, b.notes,
              b.amount_paid, b.total_paid, b.refunded_at, b.created_at,
              b.rescheduled_at, b.rescheduled_from_date, b.service_duration_minutes
       FROM bookings b
       WHERE b.date BETWEEN $1::date AND $2::date
       ORDER BY b.date ASC
       LIMIT 20000`,
      [start, end],
    ),
  );
  return r.rows || [];
}

async function gatherWaitlistRows(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT id, status, barber_name, service_name, preferred_date::text AS preferred_date,
              date_from::text AS date_from, date_to::text AS date_to,
              time_range_start::text AS time_range_start, time_range_end::text AS time_range_end,
              any_qualified_barber, deleted_at, source
       FROM aura_waitlist_requests
       WHERE deleted_at IS NULL
       LIMIT 5000`,
    );
    return (r.rows || []).filter((row) => {
      const src = String(row.source || "");
      return !/aura_p3|pipeline-test|controlled_/i.test(src);
    });
  } catch {
    return [];
  }
}

async function gatherWaitlistConversion(dbQuery, { start, end }) {
  try {
    const r = await dbQuery(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('offered','accepted_pending_booking','claimed','declined','expired','superseded'))::int AS offers,
         COUNT(*) FILTER (WHERE status = 'claimed' AND claimed_booking_id IS NOT NULL)::int AS claimed,
         COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
         COUNT(*) FILTER (WHERE status = 'expired')::int AS expired
       FROM aura_slot_offers
       WHERE created_at::date BETWEEN $1::date AND $2::date
         AND deleted_at IS NULL`,
      [start, end],
    );
    const row = r.rows?.[0] || {};
    const offers = num(row.offers);
    const claimed = num(row.claimed);
    return {
      offers,
      claimed,
      declined: num(row.declined),
      expired: num(row.expired),
      conversionRatePercent: offers > 0 ? Number(((claimed / offers) * 100).toFixed(1)) : null,
      sources: ["aura_slot_offers"],
    };
  } catch {
    return {
      offers: 0,
      claimed: 0,
      declined: 0,
      expired: 0,
      conversionRatePercent: null,
      sources: ["aura_slot_offers"],
      note: "Waitlist offer tables unavailable",
    };
  }
}

async function gatherLanguageRequests(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT lower(coalesce(preferred_language, 'en')) AS language, COUNT(*)::int AS c
       FROM app_users
       WHERE account_status = 'active'
         AND lower(coalesce(email,'')) NOT LIKE '%@pipeline-test.%'
       GROUP BY 1
       ORDER BY c DESC
       LIMIT 20`,
    );
    return {
      languagesRequested: (r.rows || []).map((x) => ({
        language: x.language,
        customers: num(x.c),
      })),
      sources: ["app_users.preferred_language"],
    };
  } catch {
    return { languagesRequested: [], sources: ["app_users.preferred_language"], note: "unavailable" };
  }
}

async function gatherRewardEligibility(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT COUNT(*)::int AS c FROM loyalty_rewards
       WHERE lower(coalesce(status,'')) IN ('available','active','eligible')`,
    );
    return {
      eligibleRewardCount: num(r.rows?.[0]?.c),
      sources: ["loyalty_rewards"],
      note: "Aggregate count only — no customer identities.",
    };
  } catch {
    return { eligibleRewardCount: null, sources: ["loyalty_rewards"], note: "unavailable" };
  }
}

async function gatherActionLogs(dbQuery, { start, end }) {
  try {
    const r = await dbQuery(
      `SELECT action, result, metadata, created_at
       FROM aura_action_logs
       WHERE created_at::date BETWEEN $1::date AND $2::date
       ORDER BY created_at DESC
       LIMIT 5000`,
      [start, end],
    );
    return r.rows || [];
  } catch {
    return [];
  }
}

async function estimateAvailableMinutes(dbQuery, { start, end, days }) {
  try {
    const avail = await dbQuery(
      `SELECT COUNT(*)::int AS rows,
              COALESCE(SUM(
                EXTRACT(EPOCH FROM (end_time - start_time)) / 60
              ), 0)::float AS minutes_per_week
       FROM barber_availability
       WHERE COALESCE(is_off, false) = false`,
    );
    const weekly = num(avail.rows?.[0]?.minutes_per_week);
    const rowCount = num(avail.rows?.[0]?.rows);
    if (!rowCount || weekly <= 0) return null;
    const weeks = Math.max(days / 7, 1 / 7);
    return weekly * weeks;
  } catch {
    return null;
  }
}

module.exports = {
  PAID_STATUSES,
  computeBookingPerformance,
  computeRevenueOperations,
  computeServiceDemand,
  computeCapacityUtilization,
  computeSystemHealth,
  isRevenueEligible,
  revenueAmount,
  gatherBookingRows,
  gatherWaitlistRows,
  gatherWaitlistConversion,
  gatherLanguageRequests,
  gatherRewardEligibility,
  gatherActionLogs,
  estimateAvailableMinutes,
  controlledTestSql,
};
