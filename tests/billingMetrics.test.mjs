import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingMetricSnapshot,
  recordBillingMetric,
  resetBillingMetricsForTests,
} from "../billingMetrics.js";

test("billing metrics increment without PII or secrets", () => {
  resetBillingMetricsForTests();
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    recordBillingMetric("verify_fail", {
      provider: "apple",
      errorClass: "apple_verify_failed",
      environment: "production",
      userId: "should-not-appear",
      purchaseToken: "tok-secret",
    });
    recordBillingMetric("webhook_fail", { provider: "google", errorClass: "google_verify_failed" });
    recordBillingMetric("duplicate", { provider: "apple" });
    const snap = billingMetricSnapshot();
    assert.equal(snap.verify_fail, 1);
    assert.equal(snap.webhook_fail, 1);
    assert.equal(snap.duplicate, 1);
    const dumped = logs.join("\n");
    assert.equal(dumped.includes("should-not-appear"), false);
    assert.equal(dumped.includes("tok-secret"), false);
    assert.match(dumped, /"event":"billing_metric"/);
    assert.match(dumped, /"metric":"verify_fail"/);
  } finally {
    console.log = orig;
  }
});
