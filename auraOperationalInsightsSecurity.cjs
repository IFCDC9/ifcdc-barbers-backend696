/**
 * Phase 3C privacy, fairness, and test-exclusion helpers.
 * Insights are read-only; this module never mutates business data.
 */

/** Controlled AURA / pipeline test rows — excluded from production totals by default. */
function controlledTestSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `(
    lower(coalesce(${p}customer_name,'')) LIKE 'aura phase %'
    OR lower(coalesce(${p}customer_name,'')) LIKE 'aura %tools%'
    OR lower(coalesce(${p}customer_name,'')) LIKE 'aura waitlist%'
    OR lower(coalesce(${p}customer_name,'')) LIKE 'aura notify%'
    OR lower(coalesce(${p}customer_email,'')) LIKE '%@pipeline-test.%'
    OR coalesce(${p}notes,'') ILIKE '%controlled_%'
    OR coalesce(${p}notes,'') ILIKE '%AURA Phase %'
    OR coalesce(${p}notes,'') ILIKE '%AURA tools%'
    OR coalesce(${p}notes,'') ILIKE '%aura_controlled%'
    OR coalesce(${p}notes,'') ILIKE '%aura_p3%'
  )`;
}

function isControlledTestBooking(row = {}) {
  const name = String(row.customer_name || row.customerName || "").toLowerCase();
  const email = String(row.customer_email || row.customerEmail || "").toLowerCase();
  const notes = String(row.notes || "");
  if (name.startsWith("aura phase") || name.includes("aura tools") || name.startsWith("aura waitlist")) {
    return true;
  }
  if (email.includes("@pipeline-test.")) return true;
  if (/controlled_|AURA Phase |AURA tools|aura_controlled|aura_p3/i.test(notes)) return true;
  return false;
}

const FORBIDDEN_RECOMMENDATION_KINDS = new Set([
  "discipline",
  "termination",
  "reduce_hours",
  "compensation_change",
  "employee_rank",
  "customer_value_score",
  "customer_risk_label",
  "demographic_ranking",
]);

const FORBIDDEN_LABEL_WORDS = [
  "undesirable",
  "low quality",
  "high value customer",
  "risky customer",
  "fire",
  "terminate",
  "discipline",
  "cut hours",
  "reduce pay",
];

function assertRecommendationAllowed(rec = {}) {
  const kind = String(rec.kind || "").toLowerCase();
  if (FORBIDDEN_RECOMMENDATION_KINDS.has(kind)) {
    return { ok: false, error: "forbidden_recommendation_kind" };
  }
  const blob = `${rec.title || ""} ${rec.observation || ""} ${rec.why || ""} ${rec.actionRequiresApproval || ""}`.toLowerCase();
  for (const w of FORBIDDEN_LABEL_WORDS) {
    if (blob.includes(w)) return { ok: false, error: "forbidden_recommendation_language" };
  }
  return { ok: true };
}

/** Strip customer PII from any insight payload before API response. */
function scrubInsightPii(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(scrubInsightPii);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).toLowerCase();
    if (
      key.includes("email") ||
      key.includes("phone") ||
      key.includes("password") ||
      key.includes("secret") ||
      key.includes("token") ||
      key.includes("card") ||
      key.includes("paypal") ||
      key === "customer_name" ||
      key === "customername" ||
      key === "notes" ||
      key === "private_notes"
    ) {
      continue;
    }
    out[k] = scrubInsightPii(v);
  }
  return out;
}

function parsePeriod({ periodStart, periodEnd, comparisonStart, comparisonEnd } = {}) {
  const ymd = (v) => {
    const s = String(v || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
  };
  const end = ymd(periodEnd) || new Date().toISOString().slice(0, 10);
  let start = ymd(periodStart);
  if (!start) {
    const d = new Date(`${end}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 27);
    start = d.toISOString().slice(0, 10);
  }
  if (start > end) return { ok: false, error: "invalid_period" };

  const days =
    Math.round((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / 86400000) + 1;

  let cmpStart = ymd(comparisonStart);
  let cmpEnd = ymd(comparisonEnd);
  if (!cmpStart || !cmpEnd) {
    const endCmp = new Date(`${start}T12:00:00Z`);
    endCmp.setUTCDate(endCmp.getUTCDate() - 1);
    cmpEnd = endCmp.toISOString().slice(0, 10);
    const startCmp = new Date(endCmp);
    startCmp.setUTCDate(startCmp.getUTCDate() - (days - 1));
    cmpStart = startCmp.toISOString().slice(0, 10);
  }

  return {
    ok: true,
    period: {
      start,
      end,
      days,
      label: `${start} → ${end} (${days} day${days === 1 ? "" : "s"})`,
    },
    comparison: {
      start: cmpStart,
      end: cmpEnd,
      label: `${cmpStart} → ${cmpEnd}`,
    },
  };
}

function reportFingerprint({ period, sections }) {
  const sec = (sections || []).slice().sort().join(",");
  return `insights:${period.start}:${period.end}:${sec}`;
}

module.exports = {
  controlledTestSql,
  isControlledTestBooking,
  FORBIDDEN_RECOMMENDATION_KINDS,
  assertRecommendationAllowed,
  scrubInsightPii,
  parsePeriod,
  reportFingerprint,
};
