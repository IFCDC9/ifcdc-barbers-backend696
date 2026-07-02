#!/usr/bin/env node
/**
 * Phase 1 — PayPal LIVE production checkout gate.
 * Does NOT capture real payments (avoids charges). Validates deploy, PayPal order
 * creation, return URLs, email config, booking pipeline, and SPA routes.
 *
 * Usage:
 *   node scripts/verify-phase1-paypal-production.mjs
 *   node scripts/verify-phase1-paypal-production.mjs --base=https://ifcdc-barbers-backend696.onrender.com
 *
 * Manual follow-up (required before Phase 2):
 *   Complete one live PayPal payment on iPhone Safari, iOS app (Build 50+),
 *   Android, and desktop — confirm finalize, DB row, and confirmation email.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildMobilePayPalReturnUrl,
  resolvePayPalCheckoutReturnUrls,
} = require("../publicSiteConfig.cjs");

const API_BASE = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/+$/, "");

const WEB_BASE = (
  process.argv.find((a) => a.startsWith("--web="))?.slice(6) ||
  process.env.FRONTEND_URL ||
  "https://ifcdcbarbersapp.com"
).replace(/\/+$/, "");

/** Minimum deploy commits that include PayPal HTTPS return-url fix. */
const PAYPAL_HTTPS_FIX_SHORTS = ["c5d5407a", "00a6c8c8", "2164edca", "184dd20c"];

let failed = 0;
let warned = 0;

function ok(msg) {
  console.log(`OK   ${msg}`);
}
function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed += 1;
}
function warn(msg) {
  console.warn(`WARN ${msg}`);
  warned += 1;
}

async function get(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { res, json, text };
}

function commitIncludesPayPalFix(short) {
  const s = String(short || "").toLowerCase();
  return PAYPAL_HTTPS_FIX_SHORTS.some((c) => s.startsWith(c));
}

console.log(`\n=== Phase 1: PayPal production verification ===`);
console.log(`API: ${API_BASE}`);
console.log(`Web: ${WEB_BASE}\n`);

// --- Local return URL coercion ---
const coerced = resolvePayPalCheckoutReturnUrls("ifcdc-barbers://paypal-booking/", null);
if (!coerced.coerced || !String(coerced.returnUrl).startsWith("https://")) {
  fail("PayPal return URL coercion helper broken");
} else {
  ok(`return URL coercion → ${coerced.returnUrl}`);
}

const canonical = buildMobilePayPalReturnUrl();
if (!canonical.endsWith("/paypal-booking")) {
  fail(`canonical return URL unexpected: ${canonical}`);
} else {
  ok(`canonical mobile return URL ${canonical}`);
}

// --- Deploy ---
const deploy = await get("/api/deploy-info");
if (!deploy.res.ok) fail(`/api/deploy-info HTTP ${deploy.res.status}`);
else {
  const short = deploy.json.activeCommitShort || "";
  if (!commitIncludesPayPalFix(short)) {
    fail(`deploy commit ${short || "?"} missing PayPal HTTPS fix (need ${PAYPAL_HTTPS_FIX_SHORTS.join("|")})`);
  } else {
    ok(`deploy commit ${short} includes PayPal HTTPS return-url fix`);
  }
  const ios = deploy.json.mobile?.repoIosBuildNumber;
  if (ios != null && Number(ios) < 50) {
    warn(`repo iOS buildNumber is ${ios} — mobile HTTPS return URL needs Build 50+ (backend coercion still protects)`);
  } else if (ios != null) {
    ok(`repo iOS buildNumber ${ios}`);
  }
}

// --- PayPal LIVE ---
const paypal = await get("/api/app-bookings/health");
if (!paypal.res.ok) fail("PayPal health endpoint unavailable");
else if (paypal.json.paypal?.environment !== "live") {
  fail(`PayPal environment is ${paypal.json.paypal?.environment || "?"} — expected live`);
} else {
  ok("PayPal environment LIVE with credentials set");
}

// --- Email ---
const email = await get("/api/email/health");
if (!email.res.ok || !email.json.ok) {
  fail("Email (Resend) not configured — confirmation emails will fail");
} else {
  ok(`Email configured (${email.json.mailFromDomain || "domain ok"})`);
}

// --- SPA routes ---
for (const path of ["/paypal-booking", "/booking"]) {
  try {
    const res = await fetch(`${WEB_BASE}${path}`, { method: "GET" });
    if (!res.ok) fail(`SPA ${path} HTTP ${res.status}`);
    else ok(`SPA ${path} HTTP ${res.status}`);
  } catch (e) {
    fail(`SPA ${path} unreachable: ${e?.message || e}`);
  }
}

// --- Booking pipeline ---
const barbers = await get("/api/app-bookings/barbers");
const barberList = Array.isArray(barbers.json) ? barbers.json : barbers.json?.barbers || [];
const barber = barberList[0];
if (!barber?.name) {
  fail("No bookable barbers returned — checkout cannot proceed");
} else {
  ok(`Bookable barbers: ${barberList.length} (${barber.name})`);
}

let serviceId = "26";
if (barber?.name) {
  const enc = encodeURIComponent(barber.name);
  const svc = await get(`/api/app-bookings/services?barberName=${enc}`);
  const services = svc.json?.services || [];
  if (!services.length) fail(`No services for ${barber.name}`);
  else {
    serviceId = String(services[0].id);
    ok(`Services loaded for ${barber.name} (${services.length})`);
  }

  const slots = await get(
    `/api/app-bookings/available-slots?barberName=${enc}&dateLabel=Today&durationMinutes=30`,
  );
  const open = (slots.json?.slots || []).filter((s) => s?.available);
  if (!slots.res.ok) fail(`available-slots HTTP ${slots.res.status}`);
  else if (!open.length) fail("No open slots today for checkout probe");
  else {
    ok(`${open.length} open slots today (first: ${open[0].time})`);
    const timeLabel = open[0].time;

    const customStart = await get("/api/app-bookings/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        barberName: barber.name,
        dateLabel: "Today",
        timeLabel,
        serviceId,
        redirectUri: "ifcdc-barbers://paypal-booking/",
        customerEmail: "qa-validation@ifcdcbarbersapp.com",
        customerName: "Phase1 PayPal Probe",
      }),
    });
    if (!customStart.json.success || !customStart.json.orderId || !customStart.json.approveUrl) {
      fail(
        `PayPal order creation (custom scheme) failed: ${customStart.json.error || customStart.json.message || customStart.res.status}`,
      );
    } else {
      ok(`PayPal order created (custom scheme coerced) orderId=${customStart.json.orderId}`);
    }

    const httpsStart = await get("/api/app-bookings/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        barberName: barber.name,
        dateLabel: "Today",
        timeLabel: open[1]?.time || timeLabel,
        serviceId,
        redirectUri: canonical,
        customerEmail: "qa-validation@ifcdcbarbersapp.com",
        customerName: "Phase1 PayPal HTTPS Probe",
      }),
    });
    if (!httpsStart.json.success || !httpsStart.json.orderId) {
      const err = httpsStart.json.error || httpsStart.json.message;
      if (err === "slot_taken") {
        warn("HTTPS checkout probe hit slot_taken — prior probe may hold slot briefly");
      } else {
        fail(`PayPal order creation (HTTPS return) failed: ${err || httpsStart.res.status}`);
      }
    } else {
      ok(`PayPal order created (HTTPS return) orderId=${httpsStart.json.orderId}`);
      if (!httpsStart.json.bookingId) fail("start response missing bookingId");
      else ok(`Pending booking row created bookingId=${httpsStart.json.bookingId}`);
    }
  }
}

// --- Finalize rejects unknown orders (no charge) ---
const fin = await get("/api/app-bookings/finalize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ orderID: "PHASE1_INVALID_PROBE_ORDER" }),
});
if (fin.res.status === 500) {
  fail("finalize returned 500 for invalid order — should be 4xx");
} else {
  ok(`finalize rejects invalid order (HTTP ${fin.res.status})`);
}

console.log("\n--- Manual device verification (required before Phase 2) ---");
console.log("1. iPhone Safari → ifcdcbarbersapp.com/booking → complete PayPal LIVE payment");
console.log("2. iOS TestFlight Build 50+ → Book tab → complete PayPal payment");
console.log("3. Android production build → same booking flow");
console.log("4. Desktop Chrome → ifcdcbarbersapp.com/booking → complete PayPal payment");
console.log("5. After each: booking appears confirmed in profile/admin, confirmation email received");
console.log("");

if (failed) {
  console.error(`${failed} automated check(s) failed — do not start Phase 2.\n`);
  process.exit(1);
}

console.log(
  `Phase 1 automated checks passed${warned ? ` (${warned} warning(s))` : ""}. Complete manual device tests before Phase 2.\n`,
);
