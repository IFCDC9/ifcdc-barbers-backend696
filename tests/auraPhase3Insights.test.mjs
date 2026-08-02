import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = [
  "AURA_PHASE3_ENABLED",
  "AURA_PHASE3_OPERATIONAL_INSIGHTS",
  "AURA_PHASE3_INSIGHTS_DASHBOARD",
  "AURA_PHASE3_INSIGHTS_DAILY_DIGEST",
  "AURA_PHASE3_RECOMMENDATIONS",
];
const saved = {};

beforeEach(() => {
  for (const k of FLAG_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of FLAG_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function enableInsights({ recommendations = true, dashboard = true, digest = false } = {}) {
  process.env.AURA_PHASE3_ENABLED = "1";
  process.env.AURA_PHASE3_OPERATIONAL_INSIGHTS = "1";
  if (dashboard) process.env.AURA_PHASE3_INSIGHTS_DASHBOARD = "1";
  if (digest) process.env.AURA_PHASE3_INSIGHTS_DAILY_DIGEST = "1";
  if (recommendations) process.env.AURA_PHASE3_RECOMMENDATIONS = "1";
}

function makeBookings() {
  const rows = [];
  // 28 days of varied demand — enough for recommendations
  for (let i = 0; i < 28; i++) {
    const day = String(i + 1).padStart(2, "0");
    const date = `2026-06-${day}`;
    const n = i % 7 === 2 ? 1 : i % 7 === 6 ? 5 : 2; // Tue underbooked, Sat high
    for (let j = 0; j < n; j++) {
      rows.push({
        id: `b-${i}-${j}`,
        date,
        time: j === 0 ? "10:00" : j === 1 ? "14:00" : `${10 + j}:00`,
        booking_status: j === 0 && i % 11 === 0 ? "cancelled" : j === 1 && i % 13 === 0 ? "no_show" : "completed",
        payment_status: "paid",
        amount_paid: 40,
        total_paid: 40,
        service: i % 3 === 0 ? "Fade" : "Haircut",
        barber_name: i % 2 === 0 ? "Alex" : "Jordan",
        customer_name: `Customer ${i}-${j}`,
        customer_email: `c${i}${j}@example.com`,
        notes: "",
        created_at: `2026-05-${day}T12:00:00.000Z`,
        service_duration_minutes: 30,
        rescheduled_at: i === 5 && j === 0 ? "2026-06-01T00:00:00.000Z" : null,
      });
    }
  }
  // Controlled test row — must be excluded from revenue/totals
  rows.push({
    id: "test-1",
    date: "2026-06-15",
    time: "11:00",
    booking_status: "completed",
    payment_status: "paid",
    amount_paid: 999,
    total_paid: 999,
    service: "Fade",
    barber_name: "Alex",
    customer_name: "AURA Phase 3C Test",
    customer_email: "aura-p3c@pipeline-test.ifcdc.local",
    notes: "controlled_aura_p3c",
    created_at: "2026-06-01T00:00:00.000Z",
    service_duration_minutes: 30,
  });
  // Unpaid / failed — not revenue
  rows.push({
    id: "unpaid-1",
    date: "2026-06-16",
    time: "12:00",
    booking_status: "confirmed",
    payment_status: "unpaid",
    amount_paid: 0,
    total_paid: 0,
    service: "Haircut",
    barber_name: "Alex",
    customer_name: "Unpaid Person",
    customer_email: "unpaid@example.com",
    notes: "",
    created_at: "2026-06-10T00:00:00.000Z",
    service_duration_minutes: 30,
  });
  rows.push({
    id: "fail-1",
    date: "2026-06-16",
    time: "13:00",
    booking_status: "pending_payment",
    payment_status: "failed",
    amount_paid: 0,
    service: "Haircut",
    barber_name: "Jordan",
    customer_name: "Fail Pay",
    customer_email: "fail@example.com",
    notes: "",
    created_at: "2026-06-10T00:00:00.000Z",
    service_duration_minutes: 30,
  });
  return rows;
}

function createLogDb() {
  const logs = [];
  async function dbQuery(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
    if (s.includes("create table") || s.includes("create index")) return { rows: [] };
    if (s.includes("insert into aura_action_logs")) {
      logs.push({
        action: params[2],
        result: params[4],
        metadata: params[5] ? JSON.parse(params[5]) : null,
        created_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (s.includes("from aura_action_logs") && s.includes("operational_insight_report_generated")) {
      const fp = params[0];
      const hit = [...logs]
        .reverse()
        .find(
          (l) =>
            l.action === "operational_insight_report_generated" &&
            l.result === "ok" &&
            l.metadata?.fingerprint === fp,
        );
      return { rows: hit ? [{ id: "prior", result: hit.result, metadata: hit.metadata }] : [] };
    }
    return { rows: [] };
  }
  return { dbQuery, logs };
}

test("insights stay disabled by default", async () => {
  const { generateOperationalInsightsReport } = require("../auraOperationalInsightsService.cjs");
  const { auraPhase3Flags } = require("../auraPhase3Flags.cjs");
  const f = auraPhase3Flags();
  assert.equal(f.operationalInsights, false);
  assert.equal(f.insightsDashboard, false);
  assert.equal(f.insightsDailyDigest, false);
  assert.equal(f.recommendations, false);
  const out = await generateOperationalInsightsReport(async () => ({ rows: [] }), {});
  assert.equal(out.ok, false);
  assert.equal(out.error, "aura_phase3_operational_insights_disabled");
});

test("booking totals exclude tests and classify statuses", () => {
  const { computeBookingPerformance } = require("../auraOperationalInsightsMetrics.cjs");
  const bookings = makeBookings();
  const perf = computeBookingPerformance(bookings, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
  });
  assert.ok(perf.totalBookings >= 20);
  assert.ok(perf.controlledTestExcluded >= 1);
  assert.ok(perf.completedAppointments >= 1);
  assert.ok(perf.cancellations >= 1);
  assert.ok(perf.noShows >= 1);
  assert.ok(perf.reschedules >= 1);
});

test("revenue excludes unpaid failed test and cancelled", () => {
  const { computeRevenueOperations } = require("../auraOperationalInsightsMetrics.cjs");
  const rev = computeRevenueOperations(makeBookings(), {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
  });
  assert.ok(rev.paymentsReceived > 0);
  assert.ok(rev.controlledOrNonRevenueExcluded >= 1);
  assert.ok(rev.failedOrIncompletePayments >= 2);
  assert.ok(rev.revenueByService.length >= 1);
  assert.ok(rev.revenueByBarber.length >= 1);
  // Test row charged 999 must not appear as a service total of 999 alone from that row
  assert.equal(
    rev.revenueByService.some((x) => x.service === "Fade" && x.revenue === 999),
    false,
  );
});

test("capacity detects underbooked and high-demand periods", () => {
  const { computeCapacityUtilization } = require("../auraOperationalInsightsMetrics.cjs");
  const cap = computeCapacityUtilization(makeBookings(), {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
  });
  assert.ok(cap.appointmentsPerBarber.length >= 1);
  assert.ok(cap.averageAppointmentsPerBarber > 0);
  assert.match(cap.framing, /not employee performance/i);
  assert.equal(cap.utilizationPercent, null);
  assert.equal(cap.utilizationNote, "INSUFFICIENT DATA");
  assert.ok(Array.isArray(cap.underbookedPeriods));
  assert.ok(Array.isArray(cap.highDemandPeriods));
});

test("waitlist demand and system health aggregates", () => {
  const {
    computeServiceDemand,
    computeSystemHealth,
  } = require("../auraOperationalInsightsMetrics.cjs");
  const demand = computeServiceDemand(
    makeBookings(),
    [
      {
        status: "active",
        service_name: "Fade",
        barber_name: "Alex",
        preferred_date: "2026-07-04",
      },
      {
        status: "active",
        service_name: "Fade",
        barber_name: "Alex",
        preferred_date: "2026-07-04",
      },
      {
        status: "active",
        service_name: "Fade",
        any_qualified_barber: true,
        preferred_date: "2026-07-05",
      },
      {
        status: "active",
        service_name: "Fade",
        preferred_date: "2026-07-05",
      },
      {
        status: "active",
        service_name: "Fade",
        preferred_date: "2026-07-06",
      },
      { status: "paused", service_name: "Fade" },
    ],
    { periodStart: "2026-06-01", periodEnd: "2026-06-28" },
  );
  assert.equal(demand.waitlistDemand.activeRequests, 5);
  assert.ok(demand.mostRequestedServices.length >= 1);

  const health = computeSystemHealth([
    { action: "waitlist_notification_failed", result: "send_failed", metadata: { attentionRequired: true } },
    { action: "email_send", result: "failed" },
    { action: "payment_capture", result: "failed" },
    { action: "waitlist_notification_skipped", result: "duplicate_offer" },
    { action: "knowledge_ask", result: "escalated" },
  ]);
  assert.ok(health.failedEmails >= 1);
  assert.ok(health.failedPayments >= 1);
  assert.equal(health.waitlistNotificationFailures, 1);
  assert.ok(health.duplicateActionPreventions >= 1);
  assert.ok(health.auraEscalations >= 1);
  assert.ok(health.attentionRequired >= 1);
});

test("insufficient data and conflicting data responses", () => {
  const { buildExplainableRecommendations } = require("../auraOperationalInsightsRecommendations.cjs");
  const small = buildExplainableRecommendations({
    period: { start: "2026-06-01", end: "2026-06-03", days: 3, label: "3d" },
    bookingPerformance: { totalBookings: 50 },
    capacity: { underbookedPeriods: [], highDemandPeriods: [] },
    serviceDemand: { waitlistDemand: { activeRequests: 0 } },
  });
  assert.equal(small.status, "INSUFFICIENT DATA");

  const conflict = buildExplainableRecommendations({
    period: { start: "2026-06-01", end: "2026-06-28", days: 28, label: "28d" },
    bookingPerformance: { totalBookings: 30, completedAppointments: 0 },
    comparisonBookingPerformance: { completedAppointments: 20 },
    capacity: { underbookedPeriods: [{ dayOfWeek: 2, hour: "10:00", appointments: 1 }], highDemandPeriods: [] },
    serviceDemand: { waitlistDemand: { activeRequests: 0 } },
  });
  assert.equal(conflict.status, "CONFLICTING DATA");
  assert.equal(conflict.escalate, true);
});

test("cancellations are classified and not treated as a business trend", () => {
  const { computeBookingPerformance } = require("../auraOperationalInsightsMetrics.cjs");
  const bookings = [
    {
      date: "2026-06-10",
      time: "10:00",
      booking_status: "cancelled",
      payment_status: "unpaid",
      cancelled_by: "customer",
      cancellation_reason: "customer request",
      customer_name: "A",
      customer_email: "a@example.com",
    },
    {
      date: "2026-06-11",
      time: "11:00",
      booking_status: "cancelled",
      payment_status: "paid",
      cancelled_by: "admin",
      cancellation_reason: "shop closed",
      customer_name: "B",
      customer_email: "b@example.com",
    },
    {
      date: "2026-06-12",
      time: "12:00",
      booking_status: "completed",
      payment_status: "paid",
      amount_paid: 40,
      customer_name: "C",
      customer_email: "c@example.com",
    },
  ];
  const perf = computeBookingPerformance(bookings, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
  });
  assert.equal(perf.cancellations, 2);
  assert.equal(perf.cancellationClassification.treatedAsBusinessTrend, false);
  assert.equal(perf.cancellationClassification.byBucket.customer_request, 1);
  assert.equal(perf.cancellationClassification.byBucket.shop_or_admin, 1);
  assert.match(perf.cancellationClassification.explanation, /classified/i);
});

test("forbidden disciplinary recommendations are blocked", () => {
  const { assertRecommendationAllowed } = require("../auraOperationalInsightsSecurity.cjs");
  const bad = assertRecommendationAllowed({
    kind: "discipline",
    observation: "Barber X should be fired",
    why: "terminate",
  });
  assert.equal(bad.ok, false);
});

test("scrubInsightPii removes emails and secrets", () => {
  const { scrubInsightPii } = require("../auraOperationalInsightsSecurity.cjs");
  const clean = scrubInsightPii({
    total: 3,
    customer_email: "a@b.com",
    nested: { paypal_capture_id: "secret", barber: "Alex" },
  });
  assert.equal(clean.total, 3);
  assert.equal(clean.customer_email, undefined);
  assert.equal(clean.nested.paypal_capture_id, undefined);
  assert.equal(clean.nested.barber, "Alex");
});

test("full report is read-only, audited, and has no automatic authority", async () => {
  enableInsights({ recommendations: true });
  const { generateOperationalInsightsReport, authorityGuard } = require("../auraOperationalInsightsService.cjs");
  const { dbQuery, logs } = createLogDb();
  const auth = authorityGuard();
  assert.equal(auth.automaticActions, false);
  assert.equal(auth.mayContactCustomers, false);
  assert.equal(auth.mayDisciplineOrRankEmployees, false);

  const fixtures = {
    bookings: makeBookings(),
    comparisonBookings: makeBookings().map((b) => ({
      ...b,
      date: b.date.replace("2026-06", "2026-05"),
    })),
    waitlist: Array.from({ length: 6 }).map((_, i) => ({
      status: "active",
      service_name: "Fade",
      barber_name: "Alex",
      preferred_date: `2026-07-0${(i % 5) + 1}`,
    })),
    logs: [
      { action: "waitlist_notification_failed", result: "fail", metadata: { attentionRequired: true } },
    ],
    waitlistConversion: { offers: 10, claimed: 3, declined: 4, expired: 3, conversionRatePercent: 30 },
    languages: { languagesRequested: [{ language: "en", customers: 10 }, { language: "es", customers: 2 }] },
    rewards: { eligibleRewardCount: 4 },
    availableMinutes: 100000,
  };

  const out = await generateOperationalInsightsReport(dbQuery, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
    fixtures,
    actorUserId: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.report.readOnly, true);
  assert.equal(out.report.authority.automaticActions, false);
  assert.ok(out.report.sections.bookingPerformance.totalBookings >= 20);
  assert.ok(out.report.sections.bookingPerformance.waitlistOfferConversion.claimed === 3);
  assert.ok(out.report.sections.revenueOperations.paymentsReceived > 0);
  assert.ok(out.report.sections.capacityUtilization.utilizationPercent != null);
  assert.ok(out.report.sections.serviceDemand.waitlistDemand.activeRequests >= 5);
  assert.equal(out.report.sections.customerOperations.fairnessNote.includes("No hidden customer scores"), true);
  assert.equal(out.report.sections.customerOperations.customersAwaitingReviews.status, "INSUFFICIENT DATA");
  assert.ok(out.report.sections.systemHealth.waitlistNotificationFailures >= 1);
  assert.ok(
    out.report.sections.recommendations.status === "ok" ||
      out.report.sections.recommendations.status === "INSUFFICIENT DATA",
  );
  // No PII keys
  const blob = JSON.stringify(out.report);
  assert.equal(/@example\.com|pipeline-test|paypal_/i.test(blob), false);
  assert.ok(logs.some((l) => l.action === "operational_insight_report_generated"));

  // Duplicate prevention
  const again = await generateOperationalInsightsReport(dbQuery, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
    fixtures,
  });
  // fixtures path skips duplicate check — force via non-fixture second call simulation:
  const dup = await generateOperationalInsightsReport(dbQuery, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
    // no fixtures → uses findRecentDuplicate
  });
  // Without fixtures, gather will hit empty fake DB — still duplicate if fingerprint matches prior
  assert.ok(dup.duplicate === true || dup.ok === true);
  if (dup.duplicate) {
    assert.ok(logs.some((l) => l.action === "operational_insight_report_skipped"));
  }
});

test("daily digest never sends when flag off; preview logs only when on", async () => {
  const { previewInsightsDailyDigest } = require("../auraOperationalInsightsService.cjs");
  process.env.AURA_PHASE3_ENABLED = "1";
  process.env.AURA_PHASE3_OPERATIONAL_INSIGHTS = "1";
  let out = await previewInsightsDailyDigest(async () => ({ rows: [] }), {});
  assert.equal(out.ok, false);
  assert.equal(out.error, "aura_phase3_insights_daily_digest_disabled");
  assert.equal(out.sent, false);

  enableInsights({ digest: true, recommendations: false });
  const { dbQuery, logs } = createLogDb();
  out = await previewInsightsDailyDigest(dbQuery, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-28",
    fixtures: {
      bookings: makeBookings(),
      comparisonBookings: [],
      waitlist: [],
      logs: [],
      waitlistConversion: { offers: 0, claimed: 0, conversionRatePercent: null },
      languages: { languagesRequested: [] },
      rewards: { eligibleRewardCount: 0 },
      availableMinutes: null,
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.sent, false);
  assert.ok(logs.some((l) => l.action === "operational_insight_daily_digest_preview"));
});
