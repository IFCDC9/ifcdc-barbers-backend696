import assert from "node:assert/strict";
import {
  enqueueCompanySyncById,
  isHubSpotCompanySyncEnabled,
  isHubSpotDealSyncEnabled,
  isHubSpotSyncEnabled,
  syncCompanyToHubSpot,
} from "../hubspotService.js";

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

const originalFetch = globalThis.fetch;

try {
  setEnv({
    RENDER: null,
    RENDER_SERVICE_ID: null,
    HUBSPOT_SERVICE_KEY: "test-key-not-real",
    HUBSPOT_SYNC_ENABLED: "1",
    HUBSPOT_SYNC_COMPANIES: null,
    HUBSPOT_SYNC_DEALS: null,
  });
  assert.equal(isHubSpotSyncEnabled(), true);
  assert.equal(isHubSpotCompanySyncEnabled(), false, "companies off without HUBSPOT_SYNC_COMPANIES");
  assert.equal(isHubSpotDealSyncEnabled(), false);

  setEnv({ HUBSPOT_SYNC_COMPANIES: "1" });
  assert.equal(isHubSpotCompanySyncEnabled(), true);

  setEnv({
    HUBSPOT_SYNC_COMPANIES: "1",
    RENDER: "true",
    RENDER_SERVICE_ID: "srv-d8gn9h77f7vs73evmfgg",
  });
  assert.equal(isHubSpotCompanySyncEnabled(), false, "non-canonical blocks company sync");

  setEnv({
    HUBSPOT_SYNC_ENABLED: "1",
    HUBSPOT_SYNC_COMPANIES: "0",
    HUBSPOT_SERVICE_KEY: "test-key-not-real",
    RENDER: null,
    RENDER_SERVICE_ID: null,
  });
  const disabled = await syncCompanyToHubSpot({ id: 42, name: "Test Shop" }, { reason: "unit" });
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.reason, "company_sync_disabled");

  setEnv({ HUBSPOT_SYNC_COMPANIES: "1" });
  const missing = await syncCompanyToHubSpot({ name: "No Id Shop" }, { reason: "unit" });
  assert.equal(missing.skipped, true);
  assert.equal(missing.reason, "missing_business_id");

  assert.doesNotThrow(() => enqueueCompanySyncById(42, { reason: "unit" }));
  assert.doesNotThrow(() => enqueueCompanySyncById("bad", { reason: "unit" }));

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    calls.push({ href, method });
    if (href.includes("/companies/search")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ results: [] }),
      };
    }
    if (method === "POST" && /\/companies\/?$/.test(href.replace(/\?.*$/, ""))) {
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "co-1001" }),
      };
    }
    if (method === "PATCH" && href.includes("/companies/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "co-1001" }),
      };
    }
    if (href.includes("/associations/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "{}",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    };
  };

  const created = await syncCompanyToHubSpot(
    {
      id: 99,
      name: "IFCDC Unit Shop",
      phone: "5550100999",
      city: "Atlanta",
      state: "GA",
      approval_status: "approved",
    },
    { reason: "unit_create" },
  );
  assert.equal(created.ok, true);
  assert.equal(created.action, "company_created");
  assert.equal(created.hubspotCompanyId, "co-1001");
  assert.ok(calls.some((c) => c.method === "POST" && c.href.includes("/companies")));

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    if (href.includes("/companies/search")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ results: [{ id: "co-1001", properties: { ifcdc_business_id: "99" } }] }),
      };
    }
    if (method === "PATCH") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "co-1001" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    };
  };

  const updated = await syncCompanyToHubSpot(
    { id: 99, name: "IFCDC Unit Shop Updated", approval_status: "approved" },
    { reason: "unit_update" },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "company_updated");
  assert.equal(updated.hubspotCompanyId, "co-1001");

  console.log("hubspotPhase2aCompanies tests passed");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}
