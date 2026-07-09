#!/usr/bin/env node
/**
 * Production E2E verification for Rate Me + Rewards APIs.
 * Usage: node scripts/verify-rewards-rateme-production.mjs [--base URL] [--email E] [--password P]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const email =
  process.argv.find((a) => a.startsWith("--email="))?.slice(8) ||
  process.env.VERIFY_EMAIL ||
  "apple.review@ifcdcbarbersapp.com";

const password =
  process.argv.find((a) => a.startsWith("--password="))?.slice(11) ||
  process.env.VERIFY_PASSWORD ||
  "IFCDC-Review2026!";

let failed = 0;

function ok(msg) {
  console.log(`OK  ${msg}`);
}
function fail(msg) {
  failed += 1;
  console.error(`FAIL ${msg}`);
}

async function post(path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function get(path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

console.log(`\nRate Me + Rewards production verification → ${base}\n`);

const login = await post("/api/auth/login", { email, password });
if (!login.res.ok || !login.data?.token) {
  fail(`login HTTP ${login.res.status} — ${login.data?.message || "no token"}`);
  process.exit(1);
}
ok(`login as ${email}`);
const token = String(login.data.token);

const me = await get("/api/auth/me", token);
if (!me.res.ok || !me.data?.user?.id) fail(`/api/auth/me HTTP ${me.res.status}`);
else ok(`/api/auth/me user=${me.data.user.id}`);

const reviews = await get("/api/me/reviewable-bookings", token);
if (!reviews.res.ok || reviews.data?.ok !== true) {
  fail(`reviewable-bookings HTTP ${reviews.res.status} — ${reviews.data?.message || ""}`);
} else {
  ok(`reviewable-bookings count=${Array.isArray(reviews.data.bookings) ? reviews.data.bookings.length : 0}`);
}

const loyalty = await get("/api/loyalty/me", token);
if (!loyalty.res.ok || loyalty.data?.ok !== true) {
  fail(`loyalty/me HTTP ${loyalty.res.status} — ${loyalty.data?.message || ""}`);
} else {
  const rewards = Array.isArray(loyalty.data.rewards) ? loyalty.data.rewards.length : 0;
  ok(`loyalty/me points=${loyalty.data.points} rewards=${rewards}`);
}

const refresh = await post("/api/auth/refresh", {}, token);
if (!refresh.res.ok || !refresh.data?.token) fail(`auth/refresh HTTP ${refresh.res.status}`);
else ok("auth/refresh re-issued token");

console.log(failed ? `\n${failed} check(s) failed.\n` : "\nAll Rate Me + Rewards checks passed.\n");
process.exit(failed > 0 ? 1 : 0);
