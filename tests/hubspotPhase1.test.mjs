import assert from "node:assert/strict";
import {
  clearHubSpotClientState,
  enqueueContactSync,
  isHubSpotConfigured,
  isHubSpotSyncEnabled,
  syncContactToHubSpot,
  verifyHubSpotAuthentication,
} from "../hubspotService.js";

const originalFetch = globalThis.fetch;
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

// --- Feature flags ---
setEnv({ HUBSPOT_SYNC_ENABLED: "1", HUBSPOT_SERVICE_KEY: "test-key-not-real" });
assert.equal(isHubSpotSyncEnabled(), true);
assert.equal(isHubSpotConfigured(), true);

setEnv({ HUBSPOT_SYNC_ENABLED: "0" });
assert.equal(isHubSpotSyncEnabled(), false);

setEnv({ HUBSPOT_SYNC_ENABLED: "true", HUBSPOT_SERVICE_KEY: "" });
assert.equal(isHubSpotConfigured(), false);

// --- Sync disabled is a safe no-op ---
setEnv({ HUBSPOT_SYNC_ENABLED: "0", HUBSPOT_SERVICE_KEY: "test-key-not-real" });
const disabled = await syncContactToHubSpot(
  { id: "00000000-0000-0000-0000-000000000001", email: "phase1@example.com", name: "Phase One" },
  { reason: "unit_test" },
);
assert.equal(disabled.skipped, true);
assert.equal(disabled.reason, "sync_disabled");

// enqueue must never throw
assert.doesNotThrow(() =>
  enqueueContactSync({ email: "phase1@example.com", name: "Phase One" }, { reason: "unit_test" }),
);

// --- Mocked auth + contact upsert (no real key leaked in assertions) ---
setEnv({ HUBSPOT_SYNC_ENABLED: "1", HUBSPOT_SERVICE_KEY: "test-key-not-real" });

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  calls.push({ href, method: init.method || "GET", auth: init.headers?.Authorization });
  // Ensure Authorization header uses Bearer without exposing key in test output beyond local assert
  assert.equal(String(init.headers?.Authorization || "").startsWith("Bearer "), true);
  assert.ok(!JSON.stringify(init).includes("HUBSPOT_SERVICE_KEY"));

  if (href.includes("/account-info/v3/details")) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ portalId: 12345, timeZone: "America/New_York" }),
    };
  }
  if (/\/crm\/v3\/objects\/(contacts|companies|deals)\?limit=1$/.test(href)) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ results: [] }),
    };
  }
  if (href.includes("/crm/v3/objects/contacts/") && (init.method || "GET") === "GET") {
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "resource not found" }),
    };
  }
  if (href.endsWith("/crm/v3/objects/contacts") && init.method === "POST") {
    const body = JSON.parse(init.body);
    assert.equal(body.properties.email, "phase1.client@example.com");
    assert.equal(body.properties.firstname, "Phase");
    assert.equal(body.properties.lastname, "One");
    return {
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: "hs-contact-99" }),
    };
  }
  if (href.includes("/crm/v3/objects/contacts/") && init.method === "PATCH") {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: "hs-contact-99" }),
    };
  }
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: "unexpected" }),
  };
};

clearHubSpotClientState();
const auth = await verifyHubSpotAuthentication({ includePermissions: true });
assert.equal(auth.ok, true);
assert.equal(auth.authenticated, true);
assert.equal(auth.portalId, "12345");
assert.equal(auth.permissions?.contacts?.ok, true);
assert.equal(auth.permissions?.companies?.ok, true);
assert.equal(auth.permissions?.deals?.ok, true);
assert.ok(!JSON.stringify(auth).toLowerCase().includes("test-key"));

const created = await syncContactToHubSpot(
  {
    id: "00000000-0000-0000-0000-000000000002",
    email: "phase1.client@example.com",
    name: "Phase One",
    phone: "2025550100",
  },
  { reason: "unit_create" },
);
// Local DB may be unavailable in unit context — accept either synced ok or mapping skip with ok true from HubSpot path
assert.equal(created.ok, true);
assert.equal(created.action, "contact_created");
assert.equal(created.hubspotContactId, "hs-contact-99");

// Second call: existing contact path (GET succeeds)
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes("/crm/v3/objects/contacts/") && (init.method || "GET") === "GET") {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: "hs-contact-99", properties: { email: "phase1.client@example.com" } }),
    };
  }
  if (href.includes("/crm/v3/objects/contacts/") && init.method === "PATCH") {
    const body = JSON.parse(init.body);
    assert.equal(body.properties.firstname, "Phase");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: "hs-contact-99" }),
    };
  }
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: "unexpected" }),
  };
};

const updated = await syncContactToHubSpot(
  {
    id: "00000000-0000-0000-0000-000000000002",
    email: "phase1.client@example.com",
    name: "Phase One Updated",
    phone: "2025550199",
  },
  { reason: "unit_update" },
);
assert.equal(updated.ok, true);
assert.equal(updated.action, "contact_updated");

globalThis.fetch = originalFetch;
restoreEnv();

console.log("hubspotPhase1 tests passed");
