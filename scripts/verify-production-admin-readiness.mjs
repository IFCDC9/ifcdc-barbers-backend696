#!/usr/bin/env node
/**
 * Production admin readiness — verify live backend wiring for signups, bookings, and revenue.
 * Does NOT create test accounts. Read-only probes + optional authenticated checks with ADMIN_TOKEN.
 *
 * Usage:
 *   node scripts/verify-production-admin-readiness.mjs
 *   ADMIN_TOKEN='…' node scripts/verify-production-admin-readiness.mjs
 */
const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/$/, "");

const token =
  process.argv.find((a) => a.startsWith("--token="))?.slice(8) ||
  process.env.ADMIN_TOKEN ||
  process.env.QA_TOKEN ||
  "";

let failed = 0;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK    ${msg}`);
}
function warn(msg) {
  console.warn(`WARN  ${msg}`);
}

async function get(path, { auth = false } = {}) {
  const headers = { Accept: "application/json" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { res, json };
}

console.log(`\nProduction admin readiness → ${base}\n`);

const deploy = await get("/api/deploy-info");
if (!deploy.res.ok) fail("deploy-info unavailable");
else {
  ok(`deploy commit ${deploy.json.activeCommitShort || "?"}`);
  ok(`canonical web ${deploy.json.publicWeb?.canonicalOrigin || "?"}`);
  if (deploy.json.persistentStorage?.supabaseConfigured) ok("Supabase storage configured");
  else warn("Supabase storage not confirmed");
}

const paypal = await get("/api/app-bookings/health");
if (!paypal.res.ok) fail("PayPal health endpoint missing");
else if (paypal.json.paypal?.environment === "live") ok("PayPal environment: LIVE (real payments)");
else warn(`PayPal environment: ${paypal.json.paypal?.environment || "?"} — verify Render PAYPAL_ENV=live before launch`);

const secured = [
  ["/api/admin/stats", "revenue dashboard"],
  ["/api/admin/shops", "shop roster + signups"],
  ["/api/admin/shops/dashboard", "platform MRR + platform fees"],
  ["/api/admin/barbers", "barber roster + approvals"],
  ["/api/admin/bookings", "booking history"],
  ["/api/admin/notifications", "signup alerts"],
];
for (const [path, label] of secured) {
  const { res } = await get(path);
  if (res.status === 401) ok(`${label} secured (${path})`);
  else if (res.status === 403) ok(`${label} role-gated (${path})`);
  else fail(`${path} expected 401/403 without auth, got ${res.status}`);
}

const registerProbe = await fetch(`${base}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ accountType: "barber" }),
});
const regBody = await registerProbe.json().catch(() => ({}));
if (registerProbe.status === 400 && (regBody.error || regBody.message)) {
  ok("barber signup endpoint validates input (creates pending records when complete)");
} else {
  warn(`register probe returned ${registerProbe.status} — verify signup path manually`);
}

if (!token) {
  console.log("\nOptional: pass ADMIN_TOKEN to validate live admin data shapes.\n");
} else {
  const stats = await get("/api/admin/stats", { auth: true });
  if (!stats.res.ok) fail(`admin stats with token: HTTP ${stats.res.status}`);
  else {
    const s = stats.json;
    ok(
      `admin stats: bookings=${s.allBookingsCount ?? s.totalBookings ?? 0} paid=${s.paidBookingsCount ?? 0} platformFees=$${Number(s.platformFeesCollected || 0).toFixed(2)}`,
    );
    if (typeof s.todayRevenue === "number") ok(`today revenue field present ($${s.todayRevenue.toFixed(2)})`);
    else warn("todayRevenue missing from stats — deploy latest backend");
    if (typeof s.totalBarberEarnings === "number") ok(`barber earnings field present ($${s.totalBarberEarnings.toFixed(2)})`);
    else warn("totalBarberEarnings missing from stats");
    if (Array.isArray(s.bookings)) ok(`transaction list: ${s.bookings.length} recent rows (max 500)`);
  }

  const shopsDash = await get("/api/admin/shops/dashboard", { auth: true });
  if (shopsDash.res.ok) {
    const d = shopsDash.json.dashboard || shopsDash.json;
    ok(
      `shops dashboard: total=${d.totalShops ?? "?"} pending=${d.pendingApproval ?? "?"} MRR=$${Number(d.mrr || 0).toFixed(2)} platformFees=$${Number(d.platformFeeRevenue || 0).toFixed(2)}`,
    );
  } else if (shopsDash.res.status === 403) warn("shops dashboard requires super_admin (expected for shop_owner token)");
  else fail(`shops dashboard HTTP ${shopsDash.res.status}`);

  const barbers = await get("/api/admin/barbers?pendingApproval=true", { auth: true });
  if (barbers.res.ok) {
    const list = barbers.json.barbers || barbers.json.items || [];
    ok(`pending barbers queue: ${Array.isArray(list) ? list.length : 0} rows`);
  } else fail(`admin barbers HTTP ${barbers.res.status}`);

  const shops = await get("/api/admin/shops?pendingApproval=true", { auth: true });
  if (shops.res.ok) {
    const list = shops.json.shops || shops.json.items || [];
    ok(`pending shops queue: ${Array.isArray(list) ? list.length : 0} rows`);
  } else fail(`admin shops HTTP ${shops.res.status}`);
}

console.log("\n--- Production readiness summary ---");
console.log("Signups: mobile email register (barber/shop_owner) → businesses + barbers + app_users (pending)");
console.log("Approvals: Admin → Shops (/admin/shops) + Global Barbers (/admin/barbers)");
console.log("Bookings: PayPal live checkout → bookings table → GET /api/admin/stats + /api/admin/bookings");
console.log("Revenue: platform fees + collected totals from bookings; shop MRR from businesses.monthly_price");
console.log("Note: Google/Apple OAuth creates customers only — barbers must use email register with shop details");
console.log("Note: MRR reflects configured shop plans, not PayPal subscription charge history");
console.log("Note: Barber Pro ($9.99) tracked in barber_settings — not in platform analytics totals yet\n");

if (failed) {
  console.error(`${failed} check(s) failed.\n`);
  process.exit(1);
}
console.log("All production admin readiness checks passed.\n");
