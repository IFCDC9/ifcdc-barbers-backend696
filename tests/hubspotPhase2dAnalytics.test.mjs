import assert from "node:assert/strict";
import { getHubSpotHqKpis, isHubSpotHqAnalyticsEnabled } from "../hubspotAnalyticsService.js";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function setEnv(map) {
  for (const [key, value] of Object.entries(map)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  setEnv({
    RENDER: null,
    RENDER_SERVICE_ID: null,
    HUBSPOT_SERVICE_KEY: "test-key",
    HUBSPOT_SYNC_ENABLED: "1",
    HUBSPOT_HQ_ANALYTICS: null,
  });
  assert.equal(isHubSpotHqAnalyticsEnabled(), false);

  const disabled = await getHubSpotHqKpis({ days: 30 });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.ok, true);
  assert.ok(String(disabled.message || "").includes("HUBSPOT_HQ_ANALYTICS"));

  setEnv({ HUBSPOT_HQ_ANALYTICS: "1" });
  assert.equal(isHubSpotHqAnalyticsEnabled(), true);

  console.log("hubspotPhase2dAnalytics tests passed");
} finally {
  restoreEnv();
}
