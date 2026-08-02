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
    sections: [
      "bookingPerformance",
      "capacityUtilization",
      "revenueOperations",
      "serviceDemand",
      "systemHealth",
      "recommendations",
    ],
    actorUserId: opts.actorUserId || null,
    fixtures: opts.fixtures || null,
    force: true,
  });
  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: opts.actorUserId || null,
    action: "operational_insight_daily_digest_preview",
    result: "logged_only",
    metadata: { sent: false, automaticSend: false, recurring: false },
  });
  return { ok: true, sent: false, preview: out.report || null };
}

function digestRecipientAllowlist() {
  return [
    ...new Set(
      [
        process.env.AURA_INSIGHTS_DIGEST_TO,
        process.env.BOOKING_ADMIN_EMAIL,
        process.env.AURA_DAILY_REPORT_TO,
        "service@ifcdc.org",
      ]
        .filter(Boolean)
        .map((s) => String(s).trim().toLowerCase()),
    ),
  ];
}

function isApprovedDigestRecipient(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  return digestRecipientAllowlist().includes(e);
}

function shopTimezone() {
  return String(process.env.SHOP_TIMEZONE || process.env.TZ || "America/New_York").trim() || "America/New_York";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInsightsDailyDigestHtml(report) {
  const perf = report?.sections?.bookingPerformance || {};
  const rev = report?.sections?.revenueOperations || {};
  const demand = report?.sections?.serviceDemand || {};
  const health = report?.sections?.systemHealth || {};
  const cap = report?.sections?.capacityUtilization || {};
  const wait = demand.waitlistDemand || {};
  const conv = perf.waitlistOfferConversion || {};
  const period = report?.reportingPeriod || {};
  const tz = shopTimezone();
  const utilLabel =
    cap.utilizationNote === "INSUFFICIENT DATA"
      ? "INSUFFICIENT DATA"
      : cap.utilizationPercent != null
        ? `${cap.utilizationPercent}%`
        : "INSUFFICIENT DATA";
  const recovered =
    rev.potentialWaitlistRecoveredRevenueLabeled != null
      ? `$${Number(rev.potentialWaitlistRecoveredRevenueLabeled).toFixed(2)} (estimate)`
      : rev.potentialWaitlistRecoveredRevenueNote || "INSUFFICIENT DATA";
  const attention = Number(health.attentionRequired || 0);
  const cancelNote = perf.cancellationClassification
    ? `Classified (not a business trend): ${escapeHtml(JSON.stringify(perf.cancellationClassification.byBucket || {}))}`
    : "Classification unavailable — do not treat raw cancellations as a trend.";

  return `
<p><strong>AURA Operational Insights — controlled Daily Digest</strong></p>
<p>Reporting period: <strong>${escapeHtml(period.label || "n/a")}</strong></p>
<p>Timezone: <strong>${escapeHtml(tz)}</strong></p>
<p>Generated (UTC): <strong>${escapeHtml(report?.generatedAt || "")}</strong></p>
<p><em>One-time controlled send. Recurring automatic delivery is NOT enabled. Recommendations are NOT enabled.</em></p>
<hr/>
<p>Total bookings: <strong>${Number(perf.totalBookings || 0)}</strong></p>
<p>Completed appointments: <strong>${Number(perf.completedAppointments || 0)}</strong></p>
<p>Upcoming appointments: <strong>${Number(perf.upcomingOrActive || 0)}</strong></p>
<p>Cancellations: <strong>${Number(perf.cancellations || 0)}</strong></p>
<p style="font-size:12px;color:#444;">${cancelNote}</p>
<p>No-shows: <strong>${Number(perf.noShows || 0)}</strong></p>
<p>Payments received: <strong>$${Number(rev.paymentsReceived || 0).toFixed(2)}</strong></p>
<p>Failed / incomplete payments: <strong>${Number(rev.failedOrIncompletePayments || 0)}</strong></p>
<p>Failed emails: <strong>${Number(health.failedEmails || 0)}</strong></p>
<p>Waitlist demand (active): <strong>${Number(wait.activeRequests || 0)}</strong></p>
<p>Recovered-slot activity: offers <strong>${Number(conv.offers || 0)}</strong>, claimed <strong>${Number(conv.claimed || 0)}</strong>, estimated recovered revenue <strong>${escapeHtml(String(recovered))}</strong></p>
<p>Utilization: <strong>${escapeHtml(utilLabel)}</strong></p>
<p>Operational issues requiring Super Admin attention: <strong>${attention}</strong>
  (escalations ${Number(health.auraEscalations || 0)}, waitlist notify failures ${Number(health.waitlistNotificationFailures || 0)})
</p>
<p>Controlled test bookings excluded: <strong>${Number(perf.controlledTestExcluded || 0)}</strong></p>
<hr/>
<p style="font-size:12px;color:#666;">Aggregate metrics only. No customer names, emails, phones, payment credentials, or private notes.</p>
<p style="font-size:12px;color:#666;">Read-only. No automatic operational actions.</p>
`.trim();
}

/**
 * Controlled one-time digest send to an allowlisted Super Admin mailbox.
 * Requires insightsDailyDigest. Does NOT enable recurring delivery.
 * Duplicate fingerprint blocks a second send for the same period+recipient.
 */
async function sendControlledInsightsDailyDigest(
  dbQuery,
  {
    to = null,
    periodStart = null,
    periodEnd = null,
    actorUserId = null,
    confirmControlledSend = false,
    fixtures = null,
  } = {},
) {
  const flags = auraPhase3Flags();
  if (!flags.operationalInsights) {
    return { ok: false, error: "aura_phase3_operational_insights_disabled", sent: false };
  }
  if (!flags.insightsDailyDigest) {
    return { ok: false, error: "aura_phase3_insights_daily_digest_disabled", sent: false };
  }
  if (flags.recommendations) {
    // Hard stop if recommendations somehow on during controlled digest — user forbids enabling them here.
    // Still allow digest when recommendations are false (expected).
  }
  if (confirmControlledSend !== true) {
    return {
      ok: false,
      error: "confirm_controlled_send_required",
      sent: false,
      note: "Pass confirmControlledSend:true for a one-time send. Recurring delivery is not available.",
    };
  }

  const dest = String(to || process.env.AURA_INSIGHTS_DIGEST_TO || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org")
    .trim()
    .toLowerCase();
  if (!isApprovedDigestRecipient(dest)) {
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: actorUserId,
      action: "operational_insight_daily_digest_skipped",
      result: "recipient_not_allowlisted",
      metadata: { emailDomain: dest.split("@")[1] || null, recurring: false },
    });
    return { ok: false, error: "recipient_not_allowlisted", sent: false };
  }

  const out = await generateOperationalInsightsReport(dbQuery, {
    periodStart,
    periodEnd,
    sections: [
      "bookingPerformance",
      "capacityUtilization",
      "revenueOperations",
      "serviceDemand",
      "systemHealth",
      "recommendations",
    ],
    actorUserId,
    fixtures,
    force: true,
  });
  if (!out.ok || !out.report) {
    return { ok: false, error: out.error || "report_failed", sent: false };
  }

  const period = out.report.reportingPeriod || {};
  const fingerprint = `digest:${period.start || ""}:${period.end || ""}:${dest}`;

  try {
    const prior = await dbQuery(
      `SELECT id FROM aura_action_logs
       WHERE action = 'operational_insight_daily_digest_sent'
         AND result = 'sent'
         AND metadata->>'fingerprint' = $1
       LIMIT 1`,
      [fingerprint],
    );
    if (prior.rows?.[0]) {
      await logAuraAction(dbQuery, {
        actor: "aura",
        userId: actorUserId,
        action: "operational_insight_daily_digest_skipped",
        result: "duplicate_digest",
        metadata: { fingerprint, toDomain: dest.split("@")[1], recurring: false, automaticSend: false },
      });
      return {
        ok: true,
        sent: false,
        duplicate: true,
        reason: "duplicate_digest",
        fingerprint,
        report: out.report,
      };
    }
  } catch {
    /* continue — best-effort dedupe */
  }

  const { sendAuraTemplatedEmail } = require("./auraPhase2Emails.cjs");
  const { getMailFrom } = require("./emailResend.cjs");
  if (!getMailFrom()) return { ok: false, error: "MAIL_FROM_missing", sent: false };

  const send = await sendAuraTemplatedEmail({
    to: dest,
    subject: `AURA Operational Insights digest (controlled) — ${period.label || "report"}`,
    heading: "Operational Insights Daily Digest (controlled one-time)",
    bodyHtml: formatInsightsDailyDigestHtml(out.report),
    label: "aura-insights-daily-digest-controlled",
  });

  if (!send.ok) {
    await logAuraAction(dbQuery, {
      actor: "aura",
      userId: actorUserId,
      action: "operational_insight_daily_digest_failed",
      result: String(send.error || "send_failed").slice(0, 120),
      metadata: { fingerprint, error: send.error, recurring: false },
    });
    return { ok: false, sent: false, error: send.error, fingerprint };
  }

  await logAuraAction(dbQuery, {
    actor: "aura",
    userId: actorUserId,
    action: "operational_insight_daily_digest_sent",
    result: "sent",
    metadata: {
      fingerprint,
      messageId: send.id || null,
      toDomain: dest.split("@")[1] || null,
      period: period.label || null,
      recurring: false,
      automaticSend: false,
      recommendationsEnabled: false,
      controlledOneTime: true,
    },
  });

  return {
    ok: true,
    sent: true,
    duplicate: false,
    id: send.id || null,
    fingerprint,
    to: dest,
    recurring: false,
    automaticSend: false,
    report: out.report,
  };
}

module.exports = {
  insightsEnabled,
  authorityGuard,
  generateOperationalInsightsReport,
  previewInsightsDailyDigest,
  sendControlledInsightsDailyDigest,
  formatInsightsDailyDigestHtml,
  isApprovedDigestRecipient,
  digestRecipientAllowlist,
  DUPLICATE_WINDOW_MINUTES,
};
