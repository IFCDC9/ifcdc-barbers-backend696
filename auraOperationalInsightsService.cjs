/**
 * AURA Phase 3C Operational Intelligence — read-only report orchestration.
 * Never mutates bookings, customers, payments, schedules, or preferences.
 * Never auto-applies recommendations or contacts customers.
 */

const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");
const {
  parsePeriod,
  reportFingerprint,
  scrubInsightPii,
} = require("./auraOperationalInsightsSecurity.cjs");
const {
  computeBookingPerformance,
  computeRevenueOperations,
  computeServiceDemand,
  computeCapacityUtilization,
  computeSystemHealth,
  gatherBookingRows,
  gatherWaitlistRows,
  gatherWaitlistConversion,
  gatherLanguageRequests,
  gatherRewardEligibility,
  gatherActionLogs,
  estimateAvailableMinutes,
} = require("./auraOperationalInsightsMetrics.cjs");
const { buildExplainableRecommendations } = require("./auraOperationalInsightsRecommendations.cjs");

const DUPLICATE_WINDOW_MINUTES = 15;

function insightsEnabled() {
  return Boolean(auraPhase3Flags().operationalInsights);
}

function authorityGuard() {
  return {
    automaticActions: false,
    mayChangePrices: false,
    mayCreateDiscounts: false,
    mayAlterSchedules: false,
    mayModifyServices: false,
    mayContactCustomers: false,
    mayLaunchCampaigns: false,
    mayCreateCancelRescheduleAppointments: false,
    mayIssuePaymentsOrRefunds: false,
    mayChangePermissions: false,
    mayDisciplineOrRankEmployees: false,
    note: "All recommendations require explicit Super Admin approval before any operational change.",
  };
}

async function findRecentDuplicate(dbQuery, fingerprint) {
  try {
    const r = await dbQuery(
      `SELECT id, result, metadata, created_at
       FROM aura_action_logs
       WHERE action = 'operational_insight_report_generated'
         AND result = 'ok'
         AND metadata->>'fingerprint' = $1
         AND created_at > NOW() - ($2::int * INTERVAL '1 minute')
       ORDER BY created_at DESC
       LIMIT 1`,
      [fingerprint, DUPLICATE_WINDOW_MINUTES],
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Generate a Super Admin operational insights report (read-only).
 */
async function generateOperationalInsightsReport(
  dbQuery,
  {
    periodStart = null,
    periodEnd = null,
    comparisonStart = null,
    comparisonEnd = null,
    sections = null,
    actorUserId = null,
    force = false,
    /** Optional in-memory fixtures for controlled unit tests (skips SQL gathers). */
    fixtures = null,
  } = {},
) {
  if (!insightsEnabled()) {
    return { ok: false, error: "aura_phase3_operational_insights_disabled" };
  }

  const parsed = parsePeriod({ periodStart, periodEnd, comparisonStart, comparisonEnd });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const flags = auraPhase3Flags();
  const wanted = new Set(
    (sections && sections.length
      ? sections
      : [
          "bookingPerformance",
          "capacityUtilization",
          "revenueOperations",
          "serviceDemand",
          "customerOperations",
          "systemHealth",
          "recommendations",
        ]
    ).map(String),
  );

  const fingerprint = reportFingerprint({
    period: parsed.period,
    sections: [...wanted],
  });

  if (!force && !fixtures) {
    const dup = await findRecentDuplicate(dbQuery, fingerprint);
    if (dup) {
      await logAuraAction(dbQuery, {
        actor: "aura",
        userId: actorUserId,
        action: "operational_insight_report_skipped",
        result: "duplicate_report",
        metadata: { fingerprint, priorLogId: dup.id },
      });
      const prior = dup.metadata?.report || null;
      return {
        ok: true,
        duplicate: true,
        report: prior ? scrubInsightPii(prior) : null,
        message: "Identical report generated recently; returning prior result.",
      };
    }
  }

  const { period, comparison } = parsed;
  let bookings;
  let comparisonBookings;
  let waitlist;
  let logs;
  let waitlistConversion;
  let languages;
  let rewards;
  let availableMinutes;

  if (fixtures) {
    bookings = fixtures.bookings || [];
    comparisonBookings = fixtures.comparisonBookings || [];
    waitlist = fixtures.waitlist || [];
    logs = fixtures.logs || [];
    waitlistConversion = fixtures.waitlistConversion || {
      offers: 0,
      claimed: 0,
      conversionRatePercent: null,
    };
    languages = fixtures.languages || { languagesRequested: [] };
    rewards = fixtures.rewards || { eligibleRewardCount: null };
    availableMinutes = fixtures.availableMinutes ?? null;
  } else {
    bookings = await gatherBookingRows(dbQuery, { start: period.start, end: period.end });
    comparisonBookings = await gatherBookingRows(dbQuery, {
      start: comparison.start,
      end: comparison.end,
    });
    waitlist = await gatherWaitlistRows(dbQuery);
    logs = await gatherActionLogs(dbQuery, { start: period.start, end: period.end });
    waitlistConversion = await gatherWaitlistConversion(dbQuery, {
      start: period.start,
      end: period.end,
    });
    languages = await gatherLanguageRequests(dbQuery);
    rewards = await gatherRewardEligibility(dbQuery);
    availableMinutes = await estimateAvailableMinutes(dbQuery, {
      start: period.start,
      end: period.end,
      days: period.days,
    });
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    reportingPeriod: period,
    comparisonPeriod: comparison,
    authority: authorityGuard(),
    readOnly: true,
    flags: {
      operationalInsights: flags.operationalInsights,
      insightsDashboard: flags.insightsDashboard,
      insightsDailyDigest: flags.insightsDailyDigest,
      recommendations: flags.recommendations,
    },
    sections: {},
  };

  if (wanted.has("bookingPerformance")) {
    const perf = computeBookingPerformance(bookings, {
      periodStart: period.start,
      periodEnd: period.end,
    });
    report.sections.bookingPerformance = {
      ...perf,
      waitlistOfferConversion: waitlistConversion,
    };
  }

  if (wanted.has("capacityUtilization")) {
    report.sections.capacityUtilization = computeCapacityUtilization(bookings, {
      periodStart: period.start,
      periodEnd: period.end,
      availableSlotMinutes: availableMinutes,
    });
  }

  if (wanted.has("revenueOperations")) {
    const rev = computeRevenueOperations(bookings, {
      periodStart: period.start,
      periodEnd: period.end,
    });
    const recovered =
      waitlistConversion?.claimed && rev.averageBookingValue
        ? Number((waitlistConversion.claimed * rev.averageBookingValue).toFixed(2))
        : null;
    report.sections.revenueOperations = {
      ...rev,
      potentialWaitlistRecoveredRevenueLabeled: recovered,
      potentialWaitlistRecoveredRevenueNote:
        recovered == null
          ? "INSUFFICIENT DATA or no claimed waitlist offers in period"
          : "Estimate only: claimed offers × average booking value. Not booked revenue until payment settles.",
    };
  }

  if (wanted.has("serviceDemand")) {
    report.sections.serviceDemand = {
      ...computeServiceDemand(bookings, waitlist, {
        periodStart: period.start,
        periodEnd: period.end,
      }),
      languagesRequested: languages.languagesRequested || [],
      languageSources: languages.sources,
    };
  }

  if (wanted.has("customerOperations")) {
    const perf = computeBookingPerformance(bookings, {
      periodStart: period.start,
      periodEnd: period.end,
    });
    // Repeat pattern: aggregate only — no per-customer identities or value labels.
    const emailKeys = new Map();
    for (const b of bookings) {
      const { isControlledTestBooking } = require("./auraOperationalInsightsSecurity.cjs");
      if (isControlledTestBooking(b)) continue;
      const key = String(b.customer_email || b.user_id || "").toLowerCase();
      if (!key || key.includes("@pipeline-test.")) continue;
      emailKeys.set(key, (emailKeys.get(key) || 0) + 1);
    }
    const repeatCustomers = [...emailKeys.values()].filter((n) => n >= 2).length;
    report.sections.customerOperations = {
      rewardEligibility: rewards,
      repeatBookingCustomersAggregate: repeatCustomers,
      totalDistinctCustomersAggregate: emailKeys.size,
      cancellationTrend: {
        cancellations: perf.cancellations,
        noShows: perf.noShows,
        ratePercent:
          perf.totalBookings > 0
            ? Number((((perf.cancellations + perf.noShows) / perf.totalBookings) * 100).toFixed(1))
            : null,
      },
      failedTransactionalCommunications: computeSystemHealth(logs).failedEmails,
      customersAwaitingReviews: {
        status: "INSUFFICIENT DATA",
        note: "No approved first-party awaiting-review aggregate source wired in 3C local foundation.",
      },
      fairnessNote:
        "No hidden customer scores. No valuable/undesirable/risky/low-quality labels are produced.",
      sources: ["bookings", "loyalty_rewards", "aura_action_logs"],
    };
  }

  if (wanted.has("systemHealth")) {
    report.sections.systemHealth = computeSystemHealth(logs);
  }

  if (wanted.has("recommendations")) {
    if (!flags.recommendations) {
      report.sections.recommendations = {
        status: "disabled",
        note: "AURA_PHASE3_RECOMMENDATIONS is false — metrics only.",
        recommendations: [],
      };
    } else {
      const perf = report.sections.bookingPerformance ||
        computeBookingPerformance(bookings, {
          periodStart: period.start,
          periodEnd: period.end,
        });
      const cmpPerf = computeBookingPerformance(comparisonBookings, {
        periodStart: comparison.start,
        periodEnd: comparison.end,
      });
      report.sections.recommendations = buildExplainableRecommendations({
        period,
        bookingPerformance: perf,
        capacity:
          report.sections.capacityUtilization ||
          computeCapacityUtilization(bookings, {
            periodStart: period.start,
            periodEnd: period.end,
            availableSlotMinutes: availableMinutes,
          }),
        serviceDemand:
          report.sections.serviceDemand ||
          computeServiceDemand(bookings, waitlist, {
            periodStart: period.start,
            periodEnd: period.end,
          }),
        waitlistConversion,
        comparisonBookingPerformance: cmpPerf,
      });
    }
  }

  const clean = scrubInsightPii(report);

  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: actorUserId,
    action: "operational_insight_report_generated",
    result: "ok",
    metadata: {
      fingerprint,
      period: period.label,
      sections: [...wanted],
      readOnly: true,
      automaticActions: false,
      // Store compact summary for duplicate replay (not full PII).
      report: {
        ok: true,
        generatedAt: clean.generatedAt,
        reportingPeriod: clean.reportingPeriod,
        comparisonPeriod: clean.comparisonPeriod,
        authority: clean.authority,
        flags: clean.flags,
        sections: clean.sections,
        readOnly: true,
      },
    },
  });

  return { ok: true, duplicate: false, report: clean };
}

/**
 * Daily digest stub — never sends unless insightsDailyDigest is on,
 * and even then this foundation only logs (no outbound mail here).
 */
async function previewInsightsDailyDigest(dbQuery, opts = {}) {
  const flags = auraPhase3Flags();
  if (!flags.operationalInsights) {
    return { ok: false, error: "aura_phase3_operational_insights_disabled" };
  }
  if (!flags.insightsDailyDigest) {
    return { ok: false, error: "aura_phase3_insights_daily_digest_disabled", sent: false };
  }
  const out = await generateOperationalInsightsReport(dbQuery, {
    periodStart: opts.periodStart || null,
    periodEnd: opts.periodEnd || null,
    comparisonStart: opts.comparisonStart || null,
    comparisonEnd: opts.comparisonEnd || null,
    sections: ["bookingPerformance", "systemHealth", "recommendations"],
    actorUserId: opts.actorUserId || null,
    fixtures: opts.fixtures || null,
    force: true,
  });
  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: opts.actorUserId || null,
    action: "operational_insight_daily_digest_preview",
    result: "logged_only",
    metadata: { sent: false, automaticSend: false },
  });
  return { ok: true, sent: false, preview: out.report || null };
}

module.exports = {
  insightsEnabled,
  authorityGuard,
  generateOperationalInsightsReport,
  previewInsightsDailyDigest,
  DUPLICATE_WINDOW_MINUTES,
};
