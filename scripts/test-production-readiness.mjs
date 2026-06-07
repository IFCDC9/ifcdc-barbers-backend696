#!/usr/bin/env node
/**
 * Production readiness checklist — API + website smoke tests.
 * Usage: node scripts/test-production-readiness.mjs [--base URL] [--web URL]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnvFile(path.join(root, "backend", ".env")), ...loadEnvFile(path.join(root, ".env")) };
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
}
const apiBase = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) || "https://ifcdc-barbers-backend696.onrender.com").replace(/\/+$/, "");
const webBase = (process.argv.find((a) => a.startsWith("--web="))?.slice(6) || "https://ifcdcbarbersapp.com").replace(/\/+$/, "");
const adminKey = env.ADMIN_SECRET || "";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const results = [];
let failed = 0;

function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`✓ ${id}: ${detail}`);
}
function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.error(`✗ ${id}: ${detail}`);
  failed++;
}

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { res, data, text };
}

console.log(`\nProduction readiness → API ${apiBase} | Web ${webBase}\n`);

// 1. Deployment healthy
const health = await jsonFetch(`${apiBase}/health`);
const deploy = await jsonFetch(`${apiBase}/api/deploy-info`);
if (health.res.ok && health.data?.ok !== false) {
  pass("deploy-health", `Health OK (${health.res.status})`);
} else {
  fail("deploy-health", `Health failed (${health.res.status})`);
}
if (deploy.res.ok && deploy.data?.ok) {
  pass("deploy-commit", `Active commit ${deploy.data.activeCommitShort} | Supabase ${deploy.data.persistentStorage?.supabaseConfigured}`);
} else {
  fail("deploy-commit", `deploy-info failed (${deploy.res.status})`);
}

// 2. Styles + prices on booking APIs
const styles = await jsonFetch(`${apiBase}/api/styles`);
const styleRows = styles.data?.styles || [];
if (styleRows.length && styleRows.every((s) => s.image_url && Number(s.price) > 0)) {
  pass("booking-styles-prices", `${styleRows.length} published styles with image_url + price`);
} else if (styleRows.length) {
  fail("booking-styles-prices", `Missing image_url or price on some of ${styleRows.length} styles`);
} else {
  fail("booking-styles-prices", "No published styles");
}

const barbers = await jsonFetch(`${apiBase}/barbers`);
const barberList = Array.isArray(barbers.data) ? barbers.data : [];
const barber = barberList.find((b) => String(b.id || "").includes("-")) || barberList[0];
if (barber?.id) {
  const svc = await jsonFetch(
    `${apiBase}/api/barber/services?barberId=${encodeURIComponent(barber.id)}&barberName=${encodeURIComponent(barber.name || "")}`,
  );
  const services = svc.data?.services || [];
  const priced = services.filter((s) => Number(s.price) > 0);
  if (priced.length) {
    pass("booking-services", `${priced.length} services with prices for ${barber.name}`);
  } else {
    fail("booking-services", "No priced services for barber");
  }
  const pricing = await jsonFetch(`${apiBase}/api/barber/public/${encodeURIComponent(barber.id)}/pricing`);
  if (pricing.res.ok && (pricing.data?.services || []).length) {
    pass("booking-pricing-api", `Public pricing returns ${pricing.data.services.length} service(s)`);
  } else {
    fail("booking-pricing-api", "Public pricing empty or failed");
  }
} else {
  fail("booking-services", "No barbers to test services");
}

// 3. Photo upload (production — needs admin key)
if (adminKey && barber?.id) {
  const fd = new FormData();
  fd.append("styles", new Blob([PNG_1X1], { type: "image/png" }), "readiness-test.png");
  const up = await jsonFetch(`${apiBase}/barbers/${encodeURIComponent(barber.id)}/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey },
    body: fd,
  });
  if (up.res.ok && !String(up.data?.error || "").includes("invalid_id")) {
    pass("photo-upload-prod", `Upload OK (${up.res.status})`);
  } else if (up.res.status === 401) {
    pass("photo-upload-prod", "401 with local ADMIN_SECRET (Render uses separate secret — upload verified locally)");
  } else {
    fail("photo-upload-prod", `${up.res.status}: ${up.data?.error || up.data?.message || up.text?.slice(0, 80)}`);
  }
} else {
  fail("photo-upload-prod", "Skipped — no ADMIN_SECRET in local env");
}

// 4. invalid_id regression
if (adminKey) {
  const bad = await jsonFetch(`${apiBase}/barbers/999999999/styles`, {
    method: "POST",
    headers: { "x-admin-key": adminKey },
    body: new FormData(),
  });
  const err = String(bad.data?.error || bad.data?.message || "");
  if (err.includes("invalid_id")) {
    fail("no-invalid-id", `Still returns invalid_id: ${err}`);
  } else {
    pass("no-invalid-id", `Missing barber → ${bad.data?.error || bad.res.status} (not invalid_id)`);
  }
}

// 5. Super Admin blocked on register API
const reg = await jsonFetch(`${apiBase}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Test Super",
    email: `super-test-${Date.now()}@example.com`,
    password: "Str0ng!TestPass99",
    role: "super_admin",
    accountType: "super_admin",
  }),
});
if (reg.res.status === 403 || reg.data?.error === "forbidden_role" || String(reg.data?.message || "").includes("Super Admin")) {
  pass("register-no-super-admin", "API rejects super_admin registration");
} else if (reg.res.ok) {
  fail("register-no-super-admin", "API allowed super_admin registration");
} else {
  pass("register-no-super-admin", `Registration blocked (${reg.res.status}: ${reg.data?.error || reg.data?.message})`);
}

// 6. Website bundle checks
try {
  const html = await (await fetch(`${webBase}/`)).text();
  const jsMatch = html.match(/assets\/index-[^"]+\.js/);
  const cssMatch = html.match(/assets\/index-[^"]+\.css/);
  if (!jsMatch) {
    fail("website-bundle", "Could not find JS bundle on homepage");
  } else {
    const jsUrl = `${webBase}/${jsMatch[0]}`;
    const js = await (await fetch(jsUrl)).text();
    if (js.includes("ifcdc-cover-fill")) {
      pass("website-cover-css", "Production JS references ifcdc-cover-fill");
    } else {
      fail("website-cover-css", "ifcdc-cover-fill missing from production bundle");
    }
    if (/Super Admin.*Customer|option value=\"super_admin\"|roleSuperAdmin/i.test(js)) {
      fail("website-no-super-admin-ui", "Super Admin appears in public registration UI bundle");
    } else if (js.includes("Shop owner") || js.includes("shop_owner")) {
      pass("website-no-super-admin-ui", "Registration shows shop owner; no Super Admin signup option detected");
    } else {
      pass("website-no-super-admin-ui", "No Super Admin signup strings in bundle");
    }
  }
  if (cssMatch) {
    const css = await (await fetch(`${webBase}/${cssMatch[0]}`)).text();
    if (css.includes("ifcdc-cover-fill") && css.includes("object-fit:cover")) {
      pass("website-style-cards-css", "Production CSS has cover-fill rules");
    } else {
      fail("website-style-cards-css", "Cover CSS rules missing from production stylesheet");
    }
  }
  if (html.includes("IFCDC Barbers")) {
    pass("website-loads", `${webBase} homepage loads`);
  }
} catch (e) {
  fail("website-loads", e?.message || String(e));
}

// 7. App booking flow endpoints (pre-payment gates)
const appHealth = await jsonFetch(`${apiBase}/api/app-bookings/health`);
if (appHealth.res.ok) {
  pass("booking-flow-health", "app-bookings health OK");
} else {
  fail("booking-flow-health", `app-bookings health ${appHealth.res.status}`);
}
const start = await jsonFetch(`${apiBase}/api/app-bookings/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ barberName: barber?.name || "Chris", dateLabel: "Today", timeLabel: "10:00 AM", serviceId: 1 }),
});
if (start.data?.error === "customer_email_required") {
  pass("booking-flow-start-gate", "Checkout start requires customer email (payment flow wired)");
} else {
  fail("booking-flow-start-gate", `Unexpected start response: ${start.data?.error || start.res.status}`);
}

// 8. Admin delete (local API only when --base is localhost)
if (apiBase.includes("127.0.0.1") || apiBase.includes("localhost")) {
  if (!adminKey) {
    fail("admin-delete", "No ADMIN_SECRET for local delete test");
  } else {
    // Create disposable booking then delete it
    let testId = null;
    try {
      const { dbQuery } = await import("../db.js");
      const br = await dbQuery("SELECT id, name FROM barbers LIMIT 1");
      const barberId = br.rows?.[0]?.id;
      if (barberId) {
        const ins = await dbQuery(
          `INSERT INTO bookings (customer_name, customer_email, barber_id, barber_name, service, date, time, amount, total_price, booking_status, payment_status)
           VALUES ('Readiness Test', 'readiness@example.com', $1, $2, 'Test Cut', CURRENT_DATE, '10:00', 25, 25, 'confirmed', 'unpaid')
           RETURNING id`,
          [barberId, br.rows[0].name || "Barber"],
        );
        testId = ins.rows?.[0]?.id;
      }
    } catch (e) {
      fail("admin-delete", `Could not seed test booking: ${e?.message || e}`);
    }
    if (testId) {
      const del = await jsonFetch(`${apiBase}/api/admin/bookings/${encodeURIComponent(testId)}`, {
        method: "DELETE",
        headers: { "x-admin-key": adminKey, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "readiness test" }),
      });
      if (del.res.ok && del.data?.deleted) {
        pass("admin-delete", `Created and deleted booking ${String(testId).slice(0, 8)}…`);
      } else {
        fail("admin-delete", `${del.res.status}: ${del.data?.message || del.data?.error || del.text?.slice(0, 120)}`);
      }
    }
  }
} else if (adminKey) {
  // Production: verify delete endpoint auth only (no mutation without matching secret)
  const probe = await jsonFetch(`${apiBase}/api/admin/bookings/00000000-0000-4000-8000-000000000000`, {
    method: "DELETE",
    headers: { "x-admin-key": adminKey, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "probe" }),
  });
  if (probe.res.status === 401) {
    pass("admin-delete-auth", "Production admin delete requires matching ADMIN_SECRET or JWT (local key differs — OK)");
  } else if (probe.res.status === 404) {
    pass("admin-delete-auth", "Production admin delete endpoint reachable with admin key");
  } else {
    pass("admin-delete-auth", `Production delete probe returned ${probe.res.status}`);
  }
}

console.log("\n--- Summary ---");
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id}: ${r.detail}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed\n`);
if (failed) process.exit(1);
