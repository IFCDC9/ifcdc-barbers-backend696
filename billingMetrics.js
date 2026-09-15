/**
 * In-process billing counters + structured logs.
 * Never log PII, purchase tokens, JWS, keys, emails, or user ids.
 */

export const BILLING_METRIC_NAMES = Object.freeze(["verify_fail", "webhook_fail", "duplicate"]);

const counters = {
  verify_fail: 0,
  webhook_fail: 0,
  duplicate: 0,
};

function safeErrorClass(value) {
  const s = String(value || "").trim().slice(0, 80);
  if (!s) return null;
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeProvider(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "apple" || s === "google") return s;
  return null;
}

function safeEnvironment(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "production" || s === "sandbox") return s;
  return null;
}

export function billingMetricSnapshot() {
  return {
    verify_fail: counters.verify_fail,
    webhook_fail: counters.webhook_fail,
    duplicate: counters.duplicate,
  };
}

export function resetBillingMetricsForTests() {
  counters.verify_fail = 0;
  counters.webhook_fail = 0;
  counters.duplicate = 0;
}

/**
 * @param {"verify_fail"|"webhook_fail"|"duplicate"} metric
 * @param {{ provider?: string, errorClass?: string, environment?: string }} [fields]
 */
export function recordBillingMetric(metric, fields = {}) {
  const name = String(metric || "");
  if (!BILLING_METRIC_NAMES.includes(name)) return billingMetricSnapshot();
  counters[name] += 1;
  const payload = {
    event: "billing_metric",
    metric: name,
    provider: safeProvider(fields.provider),
    errorClass: safeErrorClass(fields.errorClass),
    environment: safeEnvironment(fields.environment),
    count: counters[name],
  };
  console.log(JSON.stringify(payload));
  return billingMetricSnapshot();
}
