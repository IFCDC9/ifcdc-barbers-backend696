#!/usr/bin/env node
/**
 * Compare production barber roster vs bookable booking picker.
 * Optional: ADMIN_TOKEN for full admin/signup-audit fields.
 *
 *   node scripts/audit-bookable-barbers.mjs
 *   ADMIN_TOKEN='…' node scripts/audit-bookable-barbers.mjs
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

async function get(path, { auth = false } = {}) {
  const headers = { Accept: "application/json" };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { res, json };
}

function bookableNames(payload) {
  const list = Array.isArray(payload) ? payload : payload?.barbers || [];
  return new Set(list.map((b) => String(b?.name || "").trim()).filter(Boolean));
}

console.log(`\nBookable barber audit → ${base}\n`);

const [bookable, roster, deploy] = await Promise.all([
  get("/api/app-bookings/barbers"),
  get("/api/barbers/roster"),
  get("/api/deploy-info"),
]);

const bookableSet = bookableNames(bookable.json);
const rosterNames = Array.isArray(roster.json?.barbers) ? roster.json.barbers : [];

console.log(`Deploy commit: ${deploy.json.activeCommitShort || "?"}`);
console.log(`Bookable (mobile picker): ${bookableSet.size} → ${[...bookableSet].join(", ") || "(none)"}`);
console.log(`Roster (all barber names in DB): ${rosterNames.length}\n`);

const missing = rosterNames.filter((n) => !bookableSet.has(n));
console.log(`Excluded from booking picker (${missing.length}):`);
for (const name of missing) {
  const enc = encodeURIComponent(name);
  const svc = await get(`/api/app-bookings/services?barberName=${enc}`);
  const svcCount = Array.isArray(svc.json?.services) ? svc.json.services.length : 0;
  console.log(`  - ${name} | services=${svcCount} | servicesHTTP=${svc.res.status}`);
}

if (token) {
  console.log("\n--- Admin signup audit ---");
  const audit = await get("/api/admin/barbers/signup-audit", { auth: true });
  if (audit.res.ok) {
    const a = audit.json.audit || audit.json;
    console.log(JSON.stringify(a, null, 2));
  } else {
    console.log(`signup-audit HTTP ${audit.res.status}`);
  }

  console.log("\n--- Admin barber roster (verification / hidden / user) ---");
  const admin = await get("/api/admin/barbers?sort=name", { auth: true });
  if (admin.res.ok) {
    for (const b of admin.json.barbers || []) {
      const flags = [
        `verification=${b.verificationStatus || b.verification_status || "?"}`,
        `bookingHidden=${b.bookingHidden ?? b.booking_hidden ?? "?"}`,
        `user=${b.userEmail || b.email || "none"}`,
        `account=${b.accountStatus || b.account_status || "?"}`,
        `shop=${b.shopName || b.shop_name || "—"}`,
      ];
      const inPicker = bookableSet.has(b.name) ? "BOOKABLE" : "hidden";
      console.log(`  [${inPicker}] ${b.name} | ${flags.join(" | ")}`);
    }
  } else {
    console.log(`admin barbers HTTP ${admin.res.status}`);
  }
} else {
  console.log(
    "\nSet ADMIN_TOKEN to load verification_status, booking_hidden, app_users, and business approval flags.",
  );
}

console.log("\nBookable filter (mobile): verification_status=approved, booking_hidden=false,");
console.log("active barber role on linked app_users, shop mobile_app_access + approval, QA names excluded.\n");
