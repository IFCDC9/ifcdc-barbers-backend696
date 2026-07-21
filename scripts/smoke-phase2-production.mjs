#!/usr/bin/env node
/**
 * Final Phase 2 / production smoke checks (read-only where possible).
 *
 * Usage:
 *   node scripts/smoke-phase2-production.mjs
 *   ADMIN_SECRET=... node scripts/smoke-phase2-production.mjs   # optional KPI unlock
 */
const BASE = String(
  process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com",
).replace(/\/+$/, "");
const ADMIN = String(process.env.ADMIN_SECRET || process.env.VITE_ADMIN_API_KEY || "").trim();

async function probe(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { path, method, status: res.status, json, text: text.slice(0, 180) };
}

function okRow(name, pass, detail) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

console.log(`\n=== Phase 2 production smoke (${BASE}) ===\n`);

const health = await probe("/api/health");
okRow("API health", health.status === 200 && health.json?.status === "OK", `http ${health.status}`);

const bookings = await probe("/api/app-bookings/health");
okRow(
  "Booking + PayPal health",
  bookings.status === 200 && bookings.json?.ok === true && Boolean(bookings.json?.paypal?.clientIdSet),
  `env=${bookings.json?.paypal?.environment || "?"} http ${bookings.status}`,
);

const register = await probe("/api/auth/register", { method: "POST", body: {} });
okRow(
  "Registration route",
  register.status >= 400 && register.status < 500,
  `validation http ${register.status}`,
);

const loyalty = await probe("/api/loyalty/me");
okRow("Loyalty route", loyalty.status === 401 || loyalty.status === 200, `http ${loyalty.status}`);

const rewards = await probe("/api/barber/loyalty/rewards");
okRow("Rewards route", rewards.status === 401 || rewards.status === 200, `http ${rewards.status}`);

const reviews = await probe("/api/reviews/00000000-0000-0000-0000-000000000001", {
  method: "PATCH",
  body: {},
});
okRow("Reviews route", reviews.status === 401 || reviews.status === 404 || reviews.status === 400, `http ${reviews.status}`);

const hsStatus = await probe("/api/hubspot/status");
const phases = hsStatus.json?.phases || {};
okRow(
  "HubSpot flags",
  hsStatus.status === 200 &&
    phases.contacts &&
    phases.companies &&
    phases.deals &&
    phases.workflows &&
    phases.analytics,
  JSON.stringify(phases),
);

const hsHealth = await probe("/api/hubspot/health");
okRow(
  "HubSpot CRM health",
  hsHealth.status === 200 && hsHealth.json?.ok === true && hsHealth.json?.authenticated === true,
  hsHealth.json?.message || `http ${hsHealth.status}`,
);

const kpisAnon = await probe("/api/admin/hubspot/kpis?days=30");
okRow("HQ Analytics auth gate", kpisAnon.status === 401, `http ${kpisAnon.status}`);

if (ADMIN) {
  const kpis = await probe("/api/admin/hubspot/kpis?days=30", {
    headers: { "x-admin-key": ADMIN },
  });
  const enabled = kpis.json?.enabled === true;
  const hasGrowth = Boolean(kpis.json?.customerGrowth && !kpis.json.customerGrowth.error);
  okRow(
    "HQ Analytics (x-admin-key)",
    kpis.status === 200 && enabled && hasGrowth,
    `http ${kpis.status} enabled=${enabled}`,
  );
} else {
  console.log("SKIP  HQ Analytics admin payload — set ADMIN_SECRET on Render + local to unlock x-admin-key");
}

console.log("\nDone.\n");
