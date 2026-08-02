/**
 * Phase 3C explainable recommendations — never auto-apply.
 * Insufficient / conflicting data → INSUFFICIENT DATA (no invented trends).
 */

const { assertRecommendationAllowed } = require("./auraOperationalInsightsSecurity.cjs");

const MIN_BOOKINGS = 20;
const MIN_DAYS = 14;
const MIN_WAITLIST = 5;
const MIN_DENSITY_BUCKETS = 4;

function insufficient(reason, period, sources = []) {
  return {
    status: "INSUFFICIENT DATA",
    reason,
    reportingPeriod: period?.label || null,
    sources,
    recommendations: [],
  };
}

function buildRecommendation(raw) {
  const gate = assertRecommendationAllowed(raw);
  if (!gate.ok) return null;
  return {
    status: "ok",
    kind: raw.kind,
    observation: raw.observation,
    reportingPeriod: raw.reportingPeriod,
    sources: raw.sources || [],
    supportingMetrics: raw.supportingMetrics || {},
    confidence: raw.confidence || "low",
    why: raw.why,
    actionRequiresApproval: raw.actionRequiresApproval,
    autoApplied: false,
  };
}

/**
 * Build recommendations from computed insight sections.
 * Returns either a list or an INSUFFICIENT DATA envelope.
 */
function buildExplainableRecommendations({
  period,
  bookingPerformance,
  capacity,
  serviceDemand,
  waitlistConversion,
  comparisonBookingPerformance = null,
} = {}) {
  const sourcesBase = ["bookings", "aura_waitlist_requests", "aura_slot_offers", "aura_action_logs"];

  if (!period || period.days < MIN_DAYS) {
    return insufficient(
      `Reporting period is ${period?.days || 0} day(s); need at least ${MIN_DAYS} days.`,
      period,
      sourcesBase,
    );
  }

  const total = Number(bookingPerformance?.totalBookings || 0);
  if (total < MIN_BOOKINGS) {
    return insufficient(
      `Only ${total} non-test bookings in period; need at least ${MIN_BOOKINGS}.`,
      period,
      sourcesBase,
    );
  }

  // Conflicting signals: completed + cancelled counts both zero while total > 0 with unknown statuses only is OK;
  // conflict = comparison says large growth but current has zero completed and prior had many.
  if (
    comparisonBookingPerformance &&
    Number(comparisonBookingPerformance.completedAppointments || 0) >= 10 &&
    Number(bookingPerformance.completedAppointments || 0) === 0 &&
    total >= MIN_BOOKINGS
  ) {
    return {
      status: "CONFLICTING DATA",
      reason:
        "Completed appointments dropped to zero while volume remains high versus the comparison period. Escalate for Super Admin review instead of recommending operational changes.",
      reportingPeriod: period.label,
      sources: sourcesBase,
      recommendations: [],
      escalate: true,
    };
  }

  const out = [];

  const under = capacity?.underbookedPeriods?.[0];
  if (under && (capacity?.underbookedPeriods || []).length >= 1) {
    const util = capacity.utilizationPercent;
    const rec = buildRecommendation({
      kind: "underbooked_period",
      observation: `Day-of-week ${under.dayOfWeek} around ${under.hour} shows only ${under.appointments} appointment(s) versus denser periods in the same window.`,
      reportingPeriod: period.label,
      sources: capacity.sources || ["bookings"],
      supportingMetrics: {
        underbookedSample: under,
        utilizationPercent: util,
        averageAppointmentsPerBarber: capacity.averageAppointmentsPerBarber,
        totalBookings: total,
      },
      confidence: util != null ? "medium" : "low",
      why: "Underused appointment windows may indicate schedule gaps or weak demand awareness — not employee fault.",
      actionRequiresApproval:
        "Super Admin may review barber availability calendars or optional promotions for those times. AURA will not change schedules or launch campaigns.",
    });
    if (rec) out.push(rec);
  }

  const hot = capacity?.highDemandPeriods?.[0];
  if (hot && (capacity?.highDemandPeriods || []).length >= 1) {
    const rec = buildRecommendation({
      kind: "high_demand_period",
      observation: `Day-of-week ${hot.dayOfWeek} around ${hot.hour} shows ${hot.appointments} appointments — among the highest-density slots in the period.`,
      reportingPeriod: period.label,
      sources: capacity.sources || ["bookings"],
      supportingMetrics: { highDemandSample: hot, totalBookings: total },
      confidence: "medium",
      why: "Concentrated demand can create wait times; staffing or open-slot recovery may help if Super Admin approves.",
      actionRequiresApproval:
        "Super Admin may add availability or enable waitlist recovery messaging. AURA will not alter schedules or contact customers automatically.",
    });
    if (rec) out.push(rec);
  }

  const waitSvc = serviceDemand?.waitlistDemand;
  if (waitSvc && Number(waitSvc.activeRequests || 0) >= MIN_WAITLIST) {
    const top = (waitSvc.byService || []).sort((a, b) => b.count - a.count)[0];
    if (top) {
      const rec = buildRecommendation({
        kind: "waitlist_service_demand",
        observation: `${waitSvc.activeRequests} active waitlist request(s); top service demand is “${top.service}” (${top.count}).`,
        reportingPeriod: period.label,
        sources: serviceDemand.sources || ["aura_waitlist_requests"],
        supportingMetrics: {
          activeRequests: waitSvc.activeRequests,
          topService: top,
          offerConversion: waitlistConversion || null,
        },
        confidence: "medium",
        why: "Persistent waitlist demand suggests capacity or scheduling review for that service.",
        actionRequiresApproval:
          "Super Admin may adjust qualified barber coverage or service availability. AURA will not modify services or notify customers without approval.",
      });
      if (rec) out.push(rec);
    }
  }

  const densityCount =
    (capacity?.underbookedPeriods || []).length + (capacity?.highDemandPeriods || []).length;
  if (!out.length && densityCount < MIN_DENSITY_BUCKETS && total < MIN_BOOKINGS * 2) {
    return insufficient(
      "Not enough distinct demand patterns to form a confident recommendation.",
      period,
      sourcesBase,
    );
  }

  if (!out.length) {
    return insufficient("No recommendation crossed confidence thresholds.", period, sourcesBase);
  }

  return {
    status: "ok",
    reportingPeriod: period.label,
    sources: sourcesBase,
    recommendations: out,
  };
}

module.exports = {
  MIN_BOOKINGS,
  MIN_DAYS,
  MIN_WAITLIST,
  buildExplainableRecommendations,
  insufficient,
};
