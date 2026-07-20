import assert from "node:assert/strict";
import {
  enrichContactUserForWorkflows,
  isHubSpotWorkflowSyncEnabled,
  syncContactToHubSpot,
} from "../hubspotService.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

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
    HUBSPOT_SERVICE_KEY: "test-key-not-real",
    HUBSPOT_SYNC_ENABLED: "1",
    HUBSPOT_SYNC_WORKFLOWS: null,
  });
  assert.equal(isHubSpotWorkflowSyncEnabled(), false);

  setEnv({ HUBSPOT_SYNC_WORKFLOWS: "1" });
  assert.equal(isHubSpotWorkflowSyncEnabled(), true);

  const enriched = await enrichContactUserForWorkflows(
    {
      id: "00000000-0000-0000-0000-000000000001",
      email: "wf@example.com",
      name: "Workflow User",
      lifecycleStage: "registered",
      loyaltyPoints: 25,
      dateOfBirth: "1990-05-01",
      rebookEligible: true,
    },
    { reason: "register" },
  );
  assert.equal(enriched.lifecycleStage, "registered");
  assert.equal(enriched.loyaltyPoints, 25);

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    let body = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    calls.push({ href, method, body });
    if (href.includes("idProperty=email") || (method === "GET" && href.includes("/contacts/"))) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => "{}",
      };
    }
    if (method === "POST" && href.includes("/contacts")) {
      const props = body?.properties || {};
      assert.equal(props.ifcdc_lifecycle_stage, "registered");
      assert.equal(props.ifcdc_loyalty_points, "25");
      assert.ok(props.date_of_birth === "1990-05-01" || props.ifcdc_date_of_birth === "1990-05-01");
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "c-wf-1" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    };
  };

  const sync = await syncContactToHubSpot(
    {
      id: "00000000-0000-0000-0000-000000000001",
      email: "wf@example.com",
      name: "Workflow User",
      lifecycleStage: "registered",
      loyaltyPoints: 25,
      dateOfBirth: "1990-05-01",
    },
    { reason: "register" },
  );
  assert.equal(sync.ok, true);
  assert.equal(sync.hubspotContactId, "c-wf-1");

  console.log("hubspotPhase2cWorkflows tests passed");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}
