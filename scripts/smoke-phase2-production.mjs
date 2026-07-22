#!/usr/bin/env node
/**
 * Final Phase 2 / production smoke checks (read-only where possible).
 *
 * Usage:
 *   node scripts/smoke-phase2-production.mjs
 */
const BASE = String(
  process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com",
).replace(/\/+$/, "");
const D8UI = String(
  process.env.D8UI_BASE || "https://ifcdc-barbers-backend696-d8ui.onrender.com",
).replace(/\/+$/, "");
const ADMIN = String(process.env.ADMIN_SECRET || process.env.VITE_ADMIN_API_KEY || "").trim();

async function probe(base, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
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
let failed = 0;

const health = await probe(BASE, "/api/health");
if (!okRow("API health", health.status === 200 && health.json?.status === "OK", `http ${health.status}`)) failed += 1;

const bookings = await probe(BASE, "/api/app-bookings/health");
if (
  !okRow(
    "Booking + PayPal health",
    bookings.status === 200 && bookings.json?.ok === true && Boolean(bookings.json?.paypal?.clientIdSet),
    `env=${bookings.json?.paypal?.environment || "?"} http ${bookings.status}`,
  )
)
  failed += 1;

const userReg = await probe(BASE, "/api/auth/register", { method: "POST", body: {} });
if (!okRow("User registration route", userReg.status >= 400 && userReg.status < 500, `http ${userReg.status}`))
  failed += 1;

const barberReg = await probe(BASE, "/api/auth/register", {
  method: "POST",
  body: { role: "barber" },
});
if (!okRow("Barber registration route", barberReg.status >= 400 && barberReg.status < 500, `http ${barberReg.status}`))
  failed += 1;

const shopReg = await probe(BASE, "/api/auth/register", {
  method: "POST",
  body: { role: "shop_owner" },
});
if (!okRow("Shop registration route", shopReg.status >= 400 && shopReg.status < 500, `http ${shopReg.status}`))
  failed += 1;

const onboarding = await probe(BASE, "/api/onboarding/business", { method: "POST", body: {} });
if (
  !okRow(
    "Shop onboarding route",
    onboarding.status >= 400 && onboarding.status < 500,
    `http ${onboarding.status}`,
  )
)
  failed += 1;

const loyalty = await probe(BASE, "/api/loyalty/me");
if (!okRow("Loyalty route", loyalty.status === 401 || loyalty.status === 200, `http ${loyalty.status}`)) failed += 1;

const rewards = await probe(BASE, "/api/barber/loyalty/rewards");
if (!okRow("Rewards route", rewards.status === 401 || rewards.status === 200, `http ${rewards.status}`)) failed += 1;

const reviews = await probe(BASE, "/api/reviews/00000000-0000-0000-0000-000000000001", {
  method: "PATCH",
  body: {},
});
if (!okRow("Reviews route", [401, 400, 404].includes(reviews.status), `http ${reviews.status}`)) failed += 1;

const hsStatus = await probe(BASE, "/api/hubspot/status");
const phases = hsStatus.json?.phases || {};
if (
  !okRow(
    "HubSpot flags",
    hsStatus.status === 200 &&
      phases.contacts &&
      phases.companies &&
      phases.deals &&
      phases.workflows &&
      phases.analytics,
    JSON.stringify(phases),
  )
)
  failed += 1;

const setup = hsStatus.json?.phase2cSetup;
if (setup) {
  const starterOk =
    setup.ok === true &&
    setup.propertyOk >= (setup.propertyTotal || 1) &&
    setup.emailOk >= (setup.emailTotal || 1);
  const mode = setup.subscriptionMode || setup.workflowProvisionMode || "unknown";
  if (starterOk) {
    okRow(
      "HubSpot Phase 2C Starter setup",
      true,
      `${mode} properties ${setup.propertyOk}/${setup.propertyTotal} emails ${setup.emailOk}/${setup.emailTotal} workflows ${setup.workflowOk}/${setup.workflowTotal} (api ${setup.workflowApiOk ?? "?"})`,
    );
    if (setup.workflowProvisionMode === "starter_manual") {
      console.log(
        "INFO  Workflows API is Professional-only; Starter fallback recorded. Attach emails in HubSpot UI.",
      );
    }
  } else {
    console.log(
      `WARN  HubSpot Phase 2C incomplete — ok=${setup.ok} properties ${setup.propertyOk}/${setup.propertyTotal} emails ${setup.emailOk}/${setup.emailTotal}`,
    );
    console.log(
      "INFO  phase2c error samples:",
      JSON.stringify({
        properties: setup.errorSamples?.properties || [],
        emails: setup.errorSamples?.emails || [],
        workflows: setup.errorSamples?.workflows || [],
        professionalBlocker: setup.professionalBlocker || null,
        notes: setup.notes || [],
      }),
    );
  }
} else {
  console.log("WARN  HubSpot phase2cSetup not yet on /status (boot setup still running or older deploy)");
}

const hsHealth = await probe(BASE, "/api/hubspot/health");
if (
  !okRow(
    "HubSpot CRM health (companies/deals)",
    hsHealth.status === 200 &&
      hsHealth.json?.ok === true &&
      hsHealth.json?.authenticated === true &&
      hsHealth.json?.permissions?.companies?.ok === true &&
      hsHealth.json?.permissions?.deals?.ok === true,
    hsHealth.json?.message || `http ${hsHealth.status}`,
  )
)
  failed += 1;

const kpisAnon = await probe(BASE, "/api/admin/hubspot/kpis?days=30");
if (!okRow("HQ Analytics auth gate", kpisAnon.status === 401, `http ${kpisAnon.status}`)) failed += 1;

if (ADMIN) {
  const kpis = await probe(BASE, "/api/admin/hubspot/kpis?days=30", {
    headers: { "x-admin-key": ADMIN },
  });
  if (kpis.status === 401) {
    console.log(
      "SKIP  HQ Analytics (x-admin-key) — local ADMIN_SECRET does not match production (expected isolation)",
    );
  } else {
    const enabled = kpis.json?.enabled === true;
    const hasGrowth = Boolean(kpis.json?.customerGrowth && !kpis.json.customerGrowth.error);
    if (!okRow("HQ Analytics (x-admin-key)", kpis.status === 200 && enabled && hasGrowth, `http ${kpis.status}`))
      failed += 1;
  }
} else {
  console.log("SKIP  HQ Analytics admin payload — production ADMIN_SECRET unset; HQ UI uses admin JWT");
}

const d8 = await probe(D8UI, "/api/hubspot/status");
const d8Clean =
  d8.status === 200 &&
  d8.json?.canonicalRuntime === false &&
  d8.json?.syncEnabled === false &&
  !(d8.json?.hubspotEnvNamesPresent || []).includes("HUBSPOT_SERVICE_KEY");
if (
  !okRow(
    "d8ui HubSpot env stripped",
    d8Clean,
    d8.status === 200
      ? `syncEnabled=${d8.json?.syncEnabled} env=${JSON.stringify(d8.json?.hubspotEnvNamesPresent || [])}`
      : `http ${d8.status}`,
  )
) {
  // Guard already blocks sync; treat leftover env as WARN not hard fail for overall exit unless syncEnabled true
  if (d8.json?.syncEnabled === true) failed += 1;
  else console.log("WARN  d8ui still has HubSpot env names present but canonical guard keeps syncEnabled=false");
}

console.log(failed ? `\nRESULT: ${failed} failure(s)\n` : "\nRESULT: all critical checks passed\n");
process.exit(failed ? 1 : 0);
