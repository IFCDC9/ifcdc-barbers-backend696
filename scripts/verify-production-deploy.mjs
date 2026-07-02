#!/usr/bin/env node
/**
 * Verify backend696 production deploy matches expected commit + booking gates.
 * Usage: node scripts/verify-production-deploy.mjs [--base https://ifcdc-barbers-backend696.onrender.com]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const ACCEPTABLE_SHORTS = [
  "8a3a601d",
  "24354b7b",
  "c5d5407a",
  "00a6c8c8",
  "2164edca",
  "184dd20c",
];

async function get(path, init) {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { res, json, url };
}

let failed = 0;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed++;
}

function ok(msg) {
  console.log(`OK  ${msg}`);
}

console.log(`\nProduction deploy verification → ${base}\n`);

const info = await get("/api/deploy-info");
if (!info.res.ok) {
  fail(`/api/deploy-info HTTP ${info.res.status}`);
} else if (!info.json.deployCommitMatch) {
  fail(
    `deploy commit mismatch: active=${info.json.activeCommitShort || info.json.activeCommit || "?"} expected one of ${ACCEPTABLE_SHORTS.join(", ")}`,
  );
} else {
  ok(`deploy-info commit ${info.json.activeCommitShort} matches payment-fix baseline`);
}

const emailHealth = await get("/api/email/health");
if (!emailHealth.res.ok || !emailHealth.json.ok) {
  fail("email health not ok");
} else {
  ok(`email health: Resend configured, MAIL_FROM set`);
}

const start = await get("/api/app-bookings/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    barberName: "Test",
    dateLabel: "Today",
    timeLabel: "10:00 AM",
    redirectUri: "https://example.com/",
    serviceId: 1,
  }),
});
if (start.json.error !== "customer_email_required") {
  fail(
    `app-bookings/start without email: expected customer_email_required, got ${start.json.error || start.res.status}`,
  );
} else {
  ok("app-bookings/start requires customer email (8a3a601d gate live)");
}

if (failed) {
  console.error(`\n${failed} check(s) failed — do not run live PayPal tests yet.\n`);
  process.exit(1);
}
console.log("\nAll production deploy checks passed.\n");
