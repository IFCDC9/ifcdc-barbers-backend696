import assert from "node:assert/strict";
import {
  enqueueDealSyncById,
  isHubSpotDealSyncEnabled,
  resolveHubSpotDealPipeline,
  shouldSyncBookingAsDeal,
  syncDealToHubSpot,
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
    HUBSPOT_SYNC_DEALS: null,
  });
  assert.equal(isHubSpotDealSyncEnabled(), false);

  setEnv({ HUBSPOT_SYNC_DEALS: "1" });
  assert.equal(isHubSpotDealSyncEnabled(), true);

  assert.equal(
    shouldSyncBookingAsDeal({ id: "b1", booking_status: "pending_payment", payment_status: "unpaid" }),
    false,
  );
  assert.equal(
    shouldSyncBookingAsDeal({ id: "b1", booking_status: "confirmed", payment_status: "paid_in_full" }),
    true,
  );
  assert.equal(
    shouldSyncBookingAsDeal({ id: "b1", booking_status: "completed", payment_status: "paid_in_full" }),
    true,
  );

  assert.equal(
    resolveHubSpotDealPipeline({ booking_status: "completed", payment_status: "paid_in_full" }).key,
    "completed",
  );
  assert.equal(
    resolveHubSpotDealPipeline({ booking_status: "confirmed", payment_status: "paid_in_full" }).key,
    "paid",
  );
  assert.equal(
    resolveHubSpotDealPipeline({ booking_status: "cancelled" }).key,
    "cancelled",
  );

  setEnv({ HUBSPOT_SYNC_DEALS: "0" });
  const disabled = await syncDealToHubSpot(
    { id: "00000000-0000-0000-0000-000000000099", booking_status: "completed", payment_status: "paid_in_full" },
    { reason: "unit" },
  );
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.reason, "deal_sync_disabled");

  setEnv({ HUBSPOT_SYNC_DEALS: "1" });
  const ineligible = await syncDealToHubSpot(
    { id: "00000000-0000-0000-0000-000000000098", booking_status: "pending_payment", payment_status: "unpaid" },
    { reason: "unit" },
  );
  assert.equal(ineligible.skipped, true);
  assert.equal(ineligible.reason, "booking_not_eligible");

  assert.doesNotThrow(() => enqueueDealSyncById("00000000-0000-0000-0000-000000000097"));

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    calls.push({ href, method });
    if (href.includes("/deals/search")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ results: [] }),
      };
    }
    if (method === "POST" && /\/deals\/?$/.test(href.replace(/\?.*$/, ""))) {
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "deal-55" }),
      };
    }
    if (method === "PATCH" && href.includes("/deals/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "deal-55" }),
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

  const booking = {
    id: "00000000-0000-0000-0000-000000000055",
    booking_status: "confirmed",
    payment_status: "paid_in_full",
    is_paid_booking: true,
    customer_name: "Test Customer",
    customer_email: "deal.phase2b@example.com",
    service: "Haircut",
    date: "2026-07-20",
    time: "10:00:00",
    total_price: 45,
    barber_id: 1,
    business_id: 2,
  };

  const created = await syncDealToHubSpot(booking, { reason: "unit_create" });
  assert.equal(created.ok, true);
  assert.equal(created.action, "deal_created");
  assert.equal(created.hubspotDealId, "deal-55");
  assert.equal(created.pipeline, "paid");

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    if (href.includes("/deals/search")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ results: [{ id: "deal-55", properties: { ifcdc_booking_id: booking.id } }] }),
      };
    }
    if (method === "PATCH") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: "deal-55" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
    };
  };

  const updated = await syncDealToHubSpot(
    { ...booking, booking_status: "completed" },
    { reason: "unit_complete" },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "deal_updated");
  assert.equal(updated.hubspotDealId, "deal-55");
  assert.equal(updated.pipeline, "completed");

  console.log("hubspotPhase2bDeals tests passed");
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}
