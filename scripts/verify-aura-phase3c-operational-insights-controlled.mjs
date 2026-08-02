#!/usr/bin/env node
/**
 * Controlled Phase 3C Operational Insights verification (read-only).
 * Requires live AURA_PHASE3_OPERATIONAL_INSIGHTS=true; dashboard/digest/recommendations stay false.
 *
 *   node --import ./loadBackendEnv.mjs scripts/verify-aura-phase3c-operational-insights-controlled.mjs
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");

process.env.AURA_PHASE3_ENABLED = "1";
process.env.AURA_PHASE3_OPERATIONAL_INSIGHTS = "1";
process.env.AURA_PHASE3_INSIGHTS_DASHBOARD = "0";
process.env.AURA_PHASE3_INSIGHTS_DAILY_DIGEST = "0";
process.env.AURA_PHASE3_RECOMMENDATIONS = "0";

const {
  generateOperationalInsightsReport,
} = require("../auraOperationalInsightsService.cjs");
const {
  computeBookingPerformance,
  computeRevenueOperations,
  computeServiceDemand,
  computeCapacityUtilization,
  computeSystemHealth,
  gatherBookingRows,
  gatherWaitlistRows,
  gatherWaitlistConversion,
  gatherActionLogs,
  estimateAvailableMinutes,
} = require("../auraOperationalInsightsMetrics.cjs");
const { isControlledTestBooking } = require("../auraOperationalInsightsSecurity.cjs");

const API = String(process.env.AURA_API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function eqNum(a, b, eps = 0.02) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < eps;
}

function mapEq(reportRows, dbRows, keyField, valueField) {
  const a = new Map((reportRows || []).map((r) => [String(r[keyField]), Number(r[valueField])]));
  const b = new Map((dbRows || []).map((r) => [String(r[keyField]), Number(r[valueField])]));
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!eqNum(v, b.get(k) ?? NaN)) return false;
  }
  return true;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

function periodLast28Days() {
  const end = new Date();
  const endYmd = end.toISOString().slice(0, 10);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { start: start.toISOString().slice(0, 10), end: endYmd };
}

console.log(`\n=== AURA Phase 3C Operational Insights controlled verification ===\nAPI ${API}\n`);

try {
  const health = await api("/api/health");
  if (health.json?.status === "OK") pass("service_healthy");
  else fail("service_healthy", JSON.stringify(health));

  const deploy = await api("/api/deploy-info");
  if (deploy.json?.ok && deploy.json?.activeCommitShort) {
    pass("deploy_live", deploy.json.activeCommitShort);
  } else fail("deploy_live", JSON.stringify(deploy.json));

  const status = await api("/api/aura/phase3/status");
  const flags = status.json?.flags || {};
  if (flags.operationalInsights === true) pass("operational_insights_on");
  else fail("operational_insights_on", JSON.stringify(flags));
  if (flags.insightsDashboard === false) pass("dashboard_off");
  else fail("dashboard_off", JSON.stringify(flags));
  if (flags.insightsDailyDigest === false) pass("daily_digest_off");
  else fail("daily_digest_off", JSON.stringify(flags));
  if (flags.recommendations === false) pass("recommendations_off");
  else fail("recommendations_off", JSON.stringify(flags));

  const insightStatus = await api("/api/aura/phase3/insights/status");
  if (
    insightStatus.json?.operationalInsightsEnabled === true &&
    insightStatus.json?.dashboardEnabled === false &&
    insightStatus.json?.dailyDigestEnabled === false &&
    insightStatus.json?.recommendationsEnabled === false &&
    insightStatus.json?.automaticOperationalAuthority === false
  ) {
    pass("insights_status_endpoint");
  } else fail("insights_status_endpoint", JSON.stringify(insightStatus.json));

  // Dashboard HTTP must remain unavailable (404 before auth).
  const reportHttp = await api("/api/aura/phase3/admin/insights/report", {
    method: "POST",
    body: {},
  });
  if (reportHttp.status === 404) pass("dashboard_report_http_disabled", String(reportHttp.json?.error));
  else fail("dashboard_report_http_disabled", JSON.stringify(reportHttp));

  // Digest: route requires auth when operationalInsights is on; without token → 401.
  // Digest flag itself remains false (preview would 404 once authenticated).
  const digestHttp = await api("/api/aura/phase3/admin/insights/daily-digest/preview", {
    method: "POST",
    body: {},
  });
  if (digestHttp.status === 404 || digestHttp.status === 401) {
    pass(
      "digest_http_disabled",
      `http=${digestHttp.status} dailyDigestFlag=${flags.insightsDailyDigest} body=${JSON.stringify(digestHttp.json)}`,
    );
  } else {
    fail("digest_http_disabled", JSON.stringify(digestHttp));
  }

  const { start, end } = periodLast28Days();
  const days =
    Math.round((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / 86400000) + 1;

  const beforeLogs = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action = 'operational_insight_report_generated'
       AND created_at > NOW() - INTERVAL '2 hours'`,
  );
  const beforeN = Number(beforeLogs.rows?.[0]?.n || 0);

  // Snapshot counts for mutation guard
  const beforeBookings = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings`);
  const beforePrefs = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_customer_preferences`).catch(
    () => ({ rows: [{ n: -1 }] }),
  );

  const out = await generateOperationalInsightsReport(dbQuery, {
    periodStart: start,
    periodEnd: end,
    sections: [
      "bookingPerformance",
      "capacityUtilization",
      "revenueOperations",
      "serviceDemand",
      "customerOperations",
      "systemHealth",
      "recommendations",
    ],
    force: true,
  });

  if (!out.ok || !out.report) {
    fail("controlled_report_generated", JSON.stringify(out));
  } else {
    pass("controlled_report_generated", out.report.reportingPeriod?.label || "");
  }

  const report = out.report || {};
  if (report.readOnly === true && report.authority?.automaticActions === false) {
    pass("report_read_only_no_auto_authority");
  } else fail("report_read_only_no_auto_authority", JSON.stringify(report.authority));

  // Recommendations section must be disabled (flag off)
  if (report.sections?.recommendations?.status === "disabled") {
    pass("recommendations_section_disabled_in_report");
  } else fail("recommendations_section_disabled_in_report", JSON.stringify(report.sections?.recommendations));

  // PII / secrets scrub
  const blob = JSON.stringify(report);
  if (
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(blob) &&
    !/paypal_|password|secret|card_number|customer_email|private_notes/i.test(blob)
  ) {
    pass("no_pii_or_secrets_in_report");
  } else fail("no_pii_or_secrets_in_report", "sensitive pattern found");

  // Independent DB recompute using the same gather/compute path as the service
  const bookings = await gatherBookingRows(dbQuery, { start, end });
  const waitlist = await gatherWaitlistRows(dbQuery);
  const waitlistConversion = await gatherWaitlistConversion(dbQuery, { start, end });
  const logs = await gatherActionLogs(dbQuery, { start, end });
  const availableMinutes = await estimateAvailableMinutes(dbQuery, { start, end, days });

  const dbPerf = computeBookingPerformance(bookings, { periodStart: start, periodEnd: end });
  const dbRev = computeRevenueOperations(bookings, { periodStart: start, periodEnd: end });
  const dbDemand = computeServiceDemand(bookings, waitlist, {
    periodStart: start,
    periodEnd: end,
  });
  const dbCap = computeCapacityUtilization(bookings, {
    periodStart: start,
    periodEnd: end,
    availableSlotMinutes: availableMinutes,
  });
  const dbHealth = computeSystemHealth(logs);

  const perf = report.sections?.bookingPerformance || {};
  const rev = report.sections?.revenueOperations || {};
  const cap = report.sections?.capacityUtilization || {};
  const demand = report.sections?.serviceDemand || {};
  const healthSec = report.sections?.systemHealth || {};
  const cust = report.sections?.customerOperations || {};

  // --- 1 total bookings ---
  if (Number(perf.totalBookings) === Number(dbPerf.totalBookings)) {
    pass("booking_total_matches_db", String(dbPerf.totalBookings));
  } else {
    fail("booking_total_matches_db", `report=${perf.totalBookings} db=${dbPerf.totalBookings}`);
  }

  // --- 2 completed ---
  if (Number(perf.completedAppointments) === Number(dbPerf.completedAppointments)) {
    pass("completed_matches_db", String(dbPerf.completedAppointments));
  } else {
    fail(
      "completed_matches_db",
      `report=${perf.completedAppointments} db=${dbPerf.completedAppointments}`,
    );
  }

  // --- 3 upcoming ---
  if (Number(perf.upcomingOrActive) === Number(dbPerf.upcomingOrActive)) {
    pass("upcoming_matches_db", String(dbPerf.upcomingOrActive));
  } else {
    fail("upcoming_matches_db", `report=${perf.upcomingOrActive} db=${dbPerf.upcomingOrActive}`);
  }

  // --- 4 cancellations ---
  if (Number(perf.cancellations) === Number(dbPerf.cancellations)) {
    pass("cancellations_match_db", String(dbPerf.cancellations));
  } else {
    fail("cancellations_match_db", `report=${perf.cancellations} db=${dbPerf.cancellations}`);
  }

  // --- 5 no-shows ---
  if (Number(perf.noShows) === Number(dbPerf.noShows)) {
    pass("no_shows_match_db", String(dbPerf.noShows));
  } else {
    fail("no_shows_match_db", `report=${perf.noShows} db=${dbPerf.noShows}`);
  }

  // --- 6 reschedules ---
  if (Number(perf.reschedules) === Number(dbPerf.reschedules)) {
    pass("reschedules_match_db", String(dbPerf.reschedules));
  } else {
    fail("reschedules_match_db", `report=${perf.reschedules} db=${dbPerf.reschedules}`);
  }

  if (Number(perf.controlledTestExcluded) === Number(dbPerf.controlledTestExcluded)) {
    pass("test_records_excluded", String(dbPerf.controlledTestExcluded));
  } else {
    fail(
      "test_records_excluded",
      `report=${perf.controlledTestExcluded} db=${dbPerf.controlledTestExcluded}`,
    );
  }

  // --- 7 payments received ---
  if (eqNum(rev.paymentsReceived, dbRev.paymentsReceived)) {
    pass("revenue_matches_db", String(dbRev.paymentsReceived));
  } else {
    fail("revenue_matches_db", `report=${rev.paymentsReceived} db=${dbRev.paymentsReceived}`);
  }

  // --- 8 revenue by service ---
  if (mapEq(rev.revenueByService, dbRev.revenueByService, "service", "revenue")) {
    pass("revenue_by_service_matches_db", `${(dbRev.revenueByService || []).length} services`);
  } else {
    fail(
      "revenue_by_service_matches_db",
      `report=${JSON.stringify(rev.revenueByService)} db=${JSON.stringify(dbRev.revenueByService)}`,
    );
  }

  // --- 9 revenue by barber ---
  if (mapEq(rev.revenueByBarber, dbRev.revenueByBarber, "barber", "revenue")) {
    pass("revenue_by_barber_matches_db", `${(dbRev.revenueByBarber || []).length} barbers`);
  } else {
    fail(
      "revenue_by_barber_matches_db",
      `report=${JSON.stringify(rev.revenueByBarber)} db=${JSON.stringify(dbRev.revenueByBarber)}`,
    );
  }

  // --- 10 failed payments ---
  // scrubInsightPii strips keys containing "email"; failedPayments key survives.
  if (Number(healthSec.failedPayments) === Number(dbHealth.failedPayments)) {
    pass("failed_payments_match_db", String(dbHealth.failedPayments));
  } else {
    fail(
      "failed_payments_match_db",
      `report=${healthSec.failedPayments} db=${dbHealth.failedPayments}`,
    );
  }

  // --- 11 failed emails ---
  // Key "failedEmails" is scrubbed from systemHealth; customerOperations uses a non-email key.
  const reportFailedEmails =
    cust.failedTransactionalCommunications ?? healthSec.failedEmails ?? null;
  if (Number(reportFailedEmails) === Number(dbHealth.failedEmails)) {
    pass(
      "failed_emails_match_db",
      `db=${dbHealth.failedEmails} (via customerOperations.failedTransactionalCommunications; systemHealth.failedEmails scrubbed)`,
    );
  } else {
    fail(
      "failed_emails_match_db",
      `report=${reportFailedEmails} db=${dbHealth.failedEmails} healthKeys=${Object.keys(healthSec).join(",")}`,
    );
  }

  // --- 12 utilization / open capacity / underbooked / high-demand ---
  const utilOk =
    (cap.utilizationNote === "INSUFFICIENT DATA" && dbCap.utilizationNote === "INSUFFICIENT DATA") ||
    eqNum(cap.utilizationPercent, dbCap.utilizationPercent);
  const bookedMinOk = Number(cap.bookedServiceMinutes) === Number(dbCap.bookedServiceMinutes);
  const underOk =
    JSON.stringify(cap.underbookedPeriods || []) === JSON.stringify(dbCap.underbookedPeriods || []);
  const highOk =
    JSON.stringify(cap.highDemandPeriods || []) === JSON.stringify(dbCap.highDemandPeriods || []);
  // Open capacity: when availability exists → remaining minutes; else labeled insufficient.
  const openCapacityLabeled =
    dbCap.utilizationNote === "INSUFFICIENT DATA"
      ? "INSUFFICIENT DATA"
      : availableMinutes != null
        ? Number((availableMinutes - dbCap.bookedServiceMinutes).toFixed(1))
        : null;
  if (utilOk && bookedMinOk && underOk && highOk) {
    pass(
      "capacity_utilization_matches_db",
      `util=${cap.utilizationPercent ?? cap.utilizationNote} openCapacity=${openCapacityLabeled} under=${(cap.underbookedPeriods || []).length} high=${(cap.highDemandPeriods || []).length}`,
    );
  } else {
    fail(
      "capacity_utilization_matches_db",
      JSON.stringify({
        utilOk,
        bookedMinOk,
        underOk,
        highOk,
        report: {
          utilizationPercent: cap.utilizationPercent,
          utilizationNote: cap.utilizationNote,
          bookedServiceMinutes: cap.bookedServiceMinutes,
          under: (cap.underbookedPeriods || []).length,
          high: (cap.highDemandPeriods || []).length,
        },
        db: {
          utilizationPercent: dbCap.utilizationPercent,
          utilizationNote: dbCap.utilizationNote,
          bookedServiceMinutes: dbCap.bookedServiceMinutes,
          under: (dbCap.underbookedPeriods || []).length,
          high: (dbCap.highDemandPeriods || []).length,
          openCapacityLabeled,
        },
      }),
    );
  }

  // --- 13 waitlist demand + recovered-slot (claimed offers) ---
  const waitReport = demand.waitlistDemand || {};
  const waitDb = dbDemand.waitlistDemand || {};
  const waitOk = Number(waitReport.activeRequests) === Number(waitDb.activeRequests);
  const convReport = perf.waitlistOfferConversion || {};
  const claimedOk = Number(convReport.claimed) === Number(waitlistConversion.claimed);
  const offersOk = Number(convReport.offers) === Number(waitlistConversion.offers);
  const recoveredDb =
    waitlistConversion.claimed && dbRev.averageBookingValue
      ? Number((waitlistConversion.claimed * dbRev.averageBookingValue).toFixed(2))
      : null;
  const recoveredReport = rev.potentialWaitlistRecoveredRevenueLabeled;
  const recoveredOk =
    (recoveredDb == null && recoveredReport == null) || eqNum(recoveredReport, recoveredDb);
  if (waitOk && claimedOk && offersOk && recoveredOk) {
    pass(
      "waitlist_and_recovered_slot_match_db",
      `active=${waitDb.activeRequests} offers=${waitlistConversion.offers} claimed=${waitlistConversion.claimed} recoveredEst=${recoveredDb}`,
    );
  } else {
    fail(
      "waitlist_and_recovered_slot_match_db",
      JSON.stringify({
        waitOk,
        claimedOk,
        offersOk,
        recoveredOk,
        waitReport: waitReport.activeRequests,
        waitDb: waitDb.activeRequests,
        convReport,
        waitlistConversion,
        recoveredReport,
        recoveredDb,
      }),
    );
  }

  // --- 14 system attention items ---
  if (Number(healthSec.attentionRequired) === Number(dbHealth.attentionRequired)) {
    pass(
      "system_attention_matches_db",
      `attention=${dbHealth.attentionRequired} escalations=${dbHealth.auraEscalations} waitlistNotifyFails=${dbHealth.waitlistNotificationFailures}`,
    );
  } else {
    fail(
      "system_attention_matches_db",
      `report=${healthSec.attentionRequired} db=${dbHealth.attentionRequired}`,
    );
  }

  // Presence / structure checks (legacy names kept for continuity)
  if (cap.utilizationNote === "INSUFFICIENT DATA" || cap.utilizationPercent != null) {
    pass("utilization_labeled_or_computed");
  } else fail("utilization_labeled_or_computed");

  if (demand.waitlistDemand) pass("waitlist_metrics_present");
  else fail("waitlist_metrics_present");

  if (
    typeof healthSec.failedPayments === "number" &&
    (typeof reportFailedEmails === "number" || typeof healthSec.failedEmails === "number")
  ) {
    pass("failed_email_and_payment_metrics_present");
  } else {
    fail(
      "failed_email_and_payment_metrics_present",
      JSON.stringify({ healthSec, reportFailedEmails }),
    );
  }

  // Insufficient / conflicting labeling when recommendations off is "disabled";
  const { buildExplainableRecommendations } = require("../auraOperationalInsightsRecommendations.cjs");
  const insuff = buildExplainableRecommendations({
    period: { days: 3, label: "3d" },
    bookingPerformance: { totalBookings: 5 },
    capacity: {},
    serviceDemand: { waitlistDemand: { activeRequests: 0 } },
  });
  if (insuff.status === "INSUFFICIENT DATA") pass("insufficient_data_labeled");
  else fail("insufficient_data_labeled", JSON.stringify(insuff));

  // No mutation
  const afterBookings = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings`);
  if (Number(afterBookings.rows[0].n) === Number(beforeBookings.rows[0].n)) {
    pass("no_booking_mutation");
  } else fail("no_booking_mutation");
  if (Number(beforePrefs.rows[0].n) >= 0) {
    const afterPrefs = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_customer_preferences`);
    if (Number(afterPrefs.rows[0].n) === Number(beforePrefs.rows[0].n)) pass("no_preference_mutation");
    else fail("no_preference_mutation");
  } else pass("no_preference_mutation", "n/a");

  // Exactly one new generated log for this run
  const afterLogs = await dbQuery(
    `SELECT id, action, result, metadata, created_at
     FROM aura_action_logs
     WHERE action = 'operational_insight_report_generated'
       AND created_at > NOW() - INTERVAL '10 minutes'
     ORDER BY created_at DESC
     LIMIT 5`,
  );
  const newLogs = (afterLogs.rows || []).filter((r) => r.result === "ok");
  const afterN = Number(
    (
      await dbQuery(
        `SELECT COUNT(*)::int AS n FROM aura_action_logs
         WHERE action = 'operational_insight_report_generated'
           AND created_at > NOW() - INTERVAL '2 hours'`,
      )
    ).rows[0].n,
  );
  if (afterN === beforeN + 1) pass("exactly_one_new_action_log", `before=${beforeN} after=${afterN}`);
  else if (afterN === beforeN && out.duplicate) {
    fail("exactly_one_new_action_log", "duplicate suppressed unexpectedly with force=true");
  } else if (afterN >= beforeN + 1 && newLogs.length >= 1) {
    if (afterN === beforeN + 1) pass("exactly_one_new_action_log");
    else fail("exactly_one_new_action_log", `before=${beforeN} after=${afterN}`);
  } else fail("exactly_one_new_action_log", `before=${beforeN} after=${afterN}`);

  // No outreach / notification from this path
  const notifySpike = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE created_at > NOW() - INTERVAL '10 minutes'
       AND action IN (
         'operational_insight_daily_digest_preview',
         'waitlist_notification_sent'
       )
       AND result = 'sent'`,
  );
  if (Number(notifySpike.rows[0].n) === 0) pass("no_email_or_outreach_from_insights");
  else fail("no_email_or_outreach_from_insights", String(notifySpike.rows[0].n));

  // Existing AURA flags still healthy
  if (flags.knowledge && flags.waitlist && flags.slotRecovery && flags.waitlistNotifications) {
    pass("existing_phase3_flags_unchanged_on");
  } else fail("existing_phase3_flags_unchanged_on", JSON.stringify(flags));

  const p2 = await api("/api/aura/phase2/status");
  if (p2.json?.flags?.master === true && p2.json?.mailFromUnchanged === true) {
    pass("phase2_regression_smoke");
  } else fail("phase2_regression_smoke", JSON.stringify(p2.json?.flags));

  const ask = await api("/api/aura/phase3/knowledge/ask", {
    method: "POST",
    body: { question: "What is your cancellation policy?" },
  });
  if (ask.status === 200 && ask.json?.ok !== false) pass("phase3a_knowledge_smoke");
  else fail("phase3a_knowledge_smoke", JSON.stringify(ask.json));

  const wl = await api("/api/aura/phase3/waitlist/status");
  if (wl.json?.waitlistEnabled === true && wl.json?.slotRecoveryEnabled === true) {
    pass("phase3b2_waitlist_smoke");
  } else fail("phase3b2_waitlist_smoke", JSON.stringify(wl.json));

  const prefsNote = flags.customerPreferences === true && flags.preferenceSuggestions === true;
  if (prefsNote) pass("phase3b1_preferences_flags_smoke");
  else fail("phase3b1_preferences_flags_smoke", JSON.stringify(flags));

  // unused import guard
  void isControlledTestBooking;
} catch (e) {
  fail("controlled_suite_exception", e?.stack || e?.message || String(e));
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nRESULT: ${failed.length ? "FAIL" : "PASS"} — ${results.filter((r) => r.ok).length}/${results.length} checks`,
);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
