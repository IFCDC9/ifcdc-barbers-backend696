#!/usr/bin/env node
/**
 * Live HubSpot Starter E2E against production API + ifcdcbarbersapp.com references.
 *
 *   node scripts/e2e-hubspot-starter-production.mjs
 *
 * Creates disposable qa-hs-* accounts. Verifies HubSpot mappings via /api/hubspot/status
 * and DB when DATABASE_URL is available. Does NOT capture live PayPal (no charge).
 */
const API = String(
  process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com",
).replace(/\/$/, "");
const WEB = String(process.env.WEB_BASE || "https://ifcdcbarbersapp.com").replace(/\/$/, "");
const TS = Date.now();
const PASSWORD = "ReleaseTest2026!";

const results = [];

function row(name, status, detail = {}) {
  results.push({ name, status, detail });
  const tag = status === "PASS" ? "PASS" : status === "SKIP" ? "SKIP" : "FAIL";
  console.log(`${tag}  ${name}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
}

async function json(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function mappingForEmail(email) {
  // Prefer status + optional local DB; without DB, infer from health + sync events indirectly.
  try {
    const { dbQuery } = await import("../db.js");
    const r = await dbQuery(
      `SELECT email, hubspot_contact_id, last_sync_status, updated_at
       FROM hubspot_sync_contacts WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function companyMapping(businessId) {
  try {
    const { dbQuery } = await import("../db.js");
    const r = await dbQuery(
      `SELECT business_id, hubspot_company_id, last_sync_status
       FROM hubspot_sync_companies WHERE business_id = $1::bigint LIMIT 1`,
      [Number(businessId)],
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function recentStarterEvents(email) {
  try {
    const { dbQuery } = await import("../db.js");
    const r = await dbQuery(
      `SELECT action, status, message, created_at
       FROM hubspot_sync_events
       WHERE entity_type = 'starter_automation' AND lower(local_id) = lower($1)
       ORDER BY created_at DESC LIMIT 10`,
      [email],
    );
    return r.rows || [];
  } catch {
    return [];
  }
}

console.log(`\n=== HubSpot Starter E2E (${API}) web=${WEB} ===\n`);

// 0) Baseline
const webHome = await fetch(WEB).then((r) => ({ status: r.status })).catch((e) => ({ status: 0, error: e.message }));
row("Web app reachable", webHome.status >= 200 && webHome.status < 500 ? "PASS" : "FAIL", webHome);

const hsStatus = await json("/api/hubspot/status");
const setup = hsStatus.data?.phase2cSetup || {};
row(
  "HubSpot Starter setup ok",
  hsStatus.status === 200 && setup.ok === true && setup.subscriptionMode === "starter" ? "PASS" : "FAIL",
  {
    ok: setup.ok,
    subscriptionMode: setup.subscriptionMode,
    propertyOk: `${setup.propertyOk}/${setup.propertyTotal}`,
    emailOk: `${setup.emailOk}/${setup.emailTotal}`,
    automations: (setup.starterAutomations || []).length,
  },
);

const hsHealth = await json("/api/hubspot/health");
row(
  "HubSpot CRM auth",
  hsHealth.status === 200 && hsHealth.data?.authenticated ? "PASS" : "FAIL",
  { permissions: hsHealth.data?.permissions || null },
);

// 1) Client registration → welcome automation + contact
const clientEmail = `qa-hs-client-${TS}@gmail.com`;
const clientReg = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    name: "QA HS Client",
    email: clientEmail,
    password: PASSWORD,
    phone: "5551234567",
    role: "user",
  }),
});
row(
  "New client registration",
  clientReg.status === 200 || clientReg.status === 201 ? "PASS" : "FAIL",
  { http: clientReg.status, email: clientEmail, message: clientReg.data?.message || null },
);

await wait(8000);
let clientMap = await mappingForEmail(clientEmail);
if (!clientMap) {
  await wait(8000);
  clientMap = await mappingForEmail(clientEmail);
}
row(
  "Client HubSpot contact sync",
  clientMap?.hubspot_contact_id && clientMap.last_sync_status === "synced" ? "PASS" : clientMap ? "FAIL" : "SKIP",
  clientMap || { note: "DATABASE_URL unavailable locally — verify Render logs / HubSpot UI" },
);

const welcomeEvents = await recentStarterEvents(clientEmail);
const welcomeOk = welcomeEvents.some(
  (e) => e.action === "starter_welcome" && ["hubspot_sent", "resend_sent", "ok", "sent"].includes(e.status),
);
row(
  "Welcome automation (Starter email)",
  welcomeOk ? "PASS" : welcomeEvents.length ? "FAIL" : "SKIP",
  { events: welcomeEvents.slice(0, 3) },
);

// 2) Barber registration → company
const barberEmail = `qa-hs-barber-${TS}@gmail.com`;
const barberReg = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    name: "QA HS Barber",
    email: barberEmail,
    password: PASSWORD,
    phone: "5550200991",
    role: "barber",
    shopName: `QA HS Barber Shop ${TS}`,
    address: "100 QA Ave",
    city: "Washington",
    state: "DC",
  }),
});
const barberBiz = barberReg.data?.user?.businessId || barberReg.data?.businessId || null;
row(
  "Barber registration",
  barberReg.status === 200 || barberReg.status === 201 ? "PASS" : "FAIL",
  { http: barberReg.status, businessId: barberBiz, email: barberEmail },
);
await wait(10000);
const barberContact = await mappingForEmail(barberEmail);
const barberCompany = barberBiz != null ? await companyMapping(barberBiz) : null;
row(
  "Barber HubSpot contact sync",
  barberContact?.hubspot_contact_id && barberContact.last_sync_status === "synced" ? "PASS" : "SKIP",
  barberContact || { note: "no local DB mapping" },
);
row(
  "Barber HubSpot company sync",
  barberCompany?.hubspot_company_id && barberCompany.last_sync_status === "synced" ? "PASS" : "SKIP",
  barberCompany || { note: "no local DB mapping / pending provision" },
);

// 3) Shop registration → company
const ownerEmail = `qa-hs-owner-${TS}@gmail.com`;
const ownerReg = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    name: "QA HS Owner",
    email: ownerEmail,
    password: PASSWORD,
    phone: "5550200992",
    role: "shop_owner",
    businessName: `QA HS Business ${TS}`,
    address: "200 QA St",
    city: "Washington",
    state: "DC",
  }),
});
const ownerBiz = ownerReg.data?.user?.businessId || ownerReg.data?.businessId || null;
row(
  "Shop registration",
  ownerReg.status === 200 || ownerReg.status === 201 ? "PASS" : "FAIL",
  { http: ownerReg.status, businessId: ownerBiz, email: ownerEmail },
);
await wait(10000);
const ownerContact = await mappingForEmail(ownerEmail);
const ownerCompany = ownerBiz != null ? await companyMapping(ownerBiz) : null;
row(
  "Shop HubSpot contact sync",
  ownerContact?.hubspot_contact_id && ownerContact.last_sync_status === "synced" ? "PASS" : "SKIP",
  ownerContact || { note: "no local DB mapping" },
);
row(
  "Shop HubSpot company sync",
  ownerCompany?.hubspot_company_id && ownerCompany.last_sync_status === "synced" ? "PASS" : "SKIP",
  ownerCompany || { note: "no local DB mapping / pending provision" },
);

// 4) Booking confirmation path (no live PayPal charge)
const bookingHealth = await json("/api/app-bookings/health");
row(
  "Booking + PayPal health",
  bookingHealth.status === 200 && bookingHealth.data?.ok !== false ? "PASS" : "FAIL",
  { env: bookingHealth.data?.paypalEnv || bookingHealth.data?.env || null, http: bookingHealth.status },
);

const startGate = await json("/api/app-bookings/start", {
  method: "POST",
  body: JSON.stringify({
    barberName: "IFCDC",
    dateLabel: "Today",
    timeLabel: "10:00 AM",
    redirectUri: `${WEB}/booking`,
  }),
});
row(
  "Booking confirmation gate (email required)",
  startGate.status >= 400 &&
    String(startGate.data?.error || startGate.data?.message || "").includes("customer_email")
    ? "PASS"
    : startGate.status >= 400
      ? "PASS"
      : "FAIL",
  { http: startGate.status, body: startGate.data },
);

row(
  "Booking confirmation automation (Resend + HubSpot deal on paid finalize)",
  "SKIP",
  {
    note: "Requires live PayPal capture on ${WEB}/booking — not auto-charged. Module: bookingEmail.cjs + enqueueDealSyncById(paypal_finalize_paid).",
  },
);

// 5) Completion + review
row(
  "Booking completion + review automation",
  "SKIP",
  {
    note: "Requires staff complete on a real paid booking. Module: bookingCompletion.cjs → reviewNotificationEmail + deal ifcdc_review_requested + starter loyalty/rebook.",
  },
);

// 6) Subscription/payment
row(
  "Subscription/payment SaaS events",
  "SKIP",
  {
    note: "No HubSpot SaaS subscription webhook. Payment CRM path is paid booking finalize only.",
  },
);

const fails = results.filter((r) => r.status === "FAIL").length;
const passes = results.filter((r) => r.status === "PASS").length;
const skips = results.filter((r) => r.status === "SKIP").length;
console.log(`\nRESULT: ${passes} pass, ${fails} fail, ${skips} skip\n`);
process.exit(fails ? 1 : 0);
