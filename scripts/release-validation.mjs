#!/usr/bin/env node
/**
 * Pre-release validation — signup, admin, booking logic, security.
 * Usage: node scripts/release-validation.mjs [--base URL] [--local-port PORT]
 *
 * Does NOT complete PayPal checkout (avoids charges). Creates labeled test
 * accounts on production when run against live API — delete after QA.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockedSlotStartsForBooking, minutesToSlotLabel } from "../barberSlotEngine.js";
import { isApprovalEmailConfigured } from "../approvalEmailService.js";

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

const env = {
  ...loadEnvFile(path.join(root, ".env")),
  ...loadEnvFile(path.join(root, "backend", ".env")),
};
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
}

const apiBase = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/+$/, "");
const localPort = Number(process.argv.find((a) => a.startsWith("--local-port="))?.slice(13) || 0);
const localBase = localPort ? `http://127.0.0.1:${localPort}` : null;
/** Signup + approval email tests use local server when available (WIP not yet on production). */
const signupBase = localBase || apiBase;

const TS = Date.now();
const PASS = "ReleaseTest2026!";
const results = [];

function record(section, id, ok, detail) {
  results.push({ section, id, ok, detail });
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} [${section}] ${id}: ${detail}`);
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

async function registerUser(payload, base = signupBase) {
  return jsonFetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function loginUser(email, password = PASS, base = apiBase) {
  return jsonFetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function authMe(token, base = apiBase) {
  return jsonFetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function adminLogin() {
  const email = env.SUPER_ADMIN_EMAIL || "service@ifcdc.org";
  const password =
    env.SUPER_ADMIN_PASSWORD ||
    env.PLATFORM_OWNER_PASSWORD ||
    env.IFCDC_OWNER_PASSWORD ||
    "";
  if (!password) return { token: null, reason: "SUPER_ADMIN_PASSWORD not in env" };
  const { res, data } = await loginUser(email, password);
  if (!res.ok || !data.token) return { token: null, reason: data.message || data.error || res.status };
  return { token: data.token, email };
}

function recordEmailDelivered(section, id, sent, messageId, inboxHint) {
  const delivered = sent === true && typeof messageId === "string" && messageId.length > 8;
  record(
    section,
    id,
    delivered || !isApprovalEmailConfigured(),
    delivered
      ? `Resend id=${messageId} (${inboxHint})`
      : isApprovalEmailConfigured()
        ? sent
          ? "sent flag set but no Resend message id"
          : "email not sent"
        : "skipped — Resend not configured",
  );
}

function barbersFromListPayload(data) {
  if (Array.isArray(data?.barbers)) return data.barbers;
  if (Array.isArray(data)) return data;
  return [];
}

console.log(`\n=== IFCDC Release Validation ===`);
console.log(`Production API: ${apiBase}`);
console.log(`Signup API: ${signupBase}`);
if (localBase) console.log(`Local API (booking WIP): ${localBase}`);
console.log(`Run id: ${TS}\n`);

// --- Email infrastructure ---
record(
  "email",
  "resend-configured",
  isApprovalEmailConfigured(),
  isApprovalEmailConfigured() ? "RESEND_API_KEY + MAIL_FROM ready" : "missing Resend config in env",
);
  record(
    "email",
    "approval-service-present",
    fs.existsSync(path.join(root, "approvalEmailService.js")),
    "approvalEmailService.js",
  );
  record(
    "email",
    "activity-log-module",
    fs.existsSync(path.join(root, "adminActivityLog.js")),
    "adminActivityLog.js",
  );
{
  const bookingEmailDiff = await import("node:child_process").then(({ execSync }) =>
    execSync("git diff --name-only bookingEmail.cjs emailResend.cjs paypalWebhookEmail.cjs 2>/dev/null || true", {
      cwd: root,
      encoding: "utf8",
    }),
  );
  record(
    "email",
    "booking-confirmation-stack-unchanged",
    !bookingEmailDiff.trim(),
    bookingEmailDiff.trim() || "bookingEmail.cjs / emailResend.cjs untouched",
  );
}

// --- Local booking logic (uncommitted code) ---
{
  const blocked = blockedSlotStartsForBooking(14 * 60 + 30, 75, 30);
  const labels = blocked.map((m) => minutesToSlotLabel(m));
  record(
    "booking-local",
    "slot-duration-blocking",
    blocked.length === 3 && labels.includes("02:30 PM"),
    `75min @ 2:30 blocks ${labels.join(", ")}`,
  );
}

// --- Security ---
{
  const reg = await jsonFetch(`${apiBase}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Elevated User",
      email: `elevate-${TS}@example.com`,
      password: PASS,
      role: "super_admin",
      accountType: "super_admin",
    }),
  });
  record(
    "security",
    "block-super-admin-register",
    reg.res.status === 403 || reg.data?.error === "forbidden_role",
    `status ${reg.res.status} error=${reg.data?.error || "—"}`,
  );
}

const reserved = await jsonFetch(`${apiBase}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Owner Impersonator",
    email: "service@ifcdc.org",
    password: PASS,
    role: "barber",
    phone: "5550000000",
    shopName: "Bad Shop",
    address: "x",
    city: "x",
    state: "x",
  }),
});
record(
  "security",
  "block-reserved-email",
  reserved.res.status === 403,
  `status ${reserved.res.status}`,
);

// --- Signup provisioning ---
const barberEmail = `rv-barber-${TS}@gmail.com`;
const ownerEmail = `rv-owner-${TS}@gmail.com`;
const rejectBarberEmail = `rv-reject-${TS}@gmail.com`;

const barberReg = await registerUser({
  name: "RV Test Barber",
  email: barberEmail,
  password: PASS,
  role: "barber",
  phone: "5550200001",
  shopName: `RV Barber Shop ${TS}`,
  address: "100 QA Ave",
  city: "DC",
  state: "MD",
});
record(
  "signup",
  "barber-register-provisions",
  barberReg.res.ok &&
    barberReg.data?.approvalPending &&
    barberReg.data?.user?.barberId &&
    barberReg.data?.user?.businessId,
  `pending=${barberReg.data?.approvalPending} barberId=${Boolean(barberReg.data?.user?.barberId)}`,
);
record(
  "signup",
  "barber-pending-approval-state",
  barberReg.data?.user?.approvalStatus === "pending" || barberReg.data?.approvalPending === true,
  `approval=${barberReg.data?.user?.approvalStatus ?? barberReg.data?.approvalPending}`,
);
record(
  "email",
  "barber-signup-admin-email",
  (barberReg.data?.adminSignupEmailSent === true &&
    typeof barberReg.data?.adminSignupEmailMessageId === "string" &&
    barberReg.data.adminSignupEmailMessageId.length > 8) ||
    !isApprovalEmailConfigured(),
  barberReg.data?.adminSignupEmailMessageId
    ? `delivered Resend id=${barberReg.data.adminSignupEmailMessageId}`
    : barberReg.data?.adminSignupEmailSent
      ? "sent flag only — restart local server if message id missing"
      : isApprovalEmailConfigured()
        ? "not sent"
        : "skipped — Resend not configured",
);

const ownerReg = await registerUser({
  name: "RV Test Owner",
  email: ownerEmail,
  password: PASS,
  role: "shop_owner",
  phone: "5550200002",
  businessName: `RV Business ${TS}`,
  address: "200 QA St",
  city: "DC",
  state: "MD",
});
record(
  "signup",
  "owner-register-provisions",
  ownerReg.res.ok && ownerReg.data?.approvalPending && ownerReg.data?.user?.businessId,
  `pending=${ownerReg.data?.approvalPending} businessId=${ownerReg.data?.user?.businessId}`,
);
record(
  "signup",
  "owner-pending-approval-state",
  ownerReg.data?.user?.approvalStatus === "pending" || ownerReg.data?.approvalPending === true,
  `approval=${ownerReg.data?.user?.approvalStatus ?? ownerReg.data?.approvalPending}`,
);
record(
  "email",
  "owner-signup-admin-email",
  (ownerReg.data?.adminSignupEmailSent === true &&
    typeof ownerReg.data?.adminSignupEmailMessageId === "string" &&
    ownerReg.data.adminSignupEmailMessageId.length > 8) ||
    !isApprovalEmailConfigured(),
  ownerReg.data?.adminSignupEmailMessageId
    ? `delivered Resend id=${ownerReg.data.adminSignupEmailMessageId}`
    : ownerReg.data?.adminSignupEmailSent
      ? "sent flag only — restart local server if message id missing"
      : isApprovalEmailConfigured()
        ? "not sent"
        : "skipped — Resend not configured",
);

const rejectReg = await registerUser({
  name: "RV Reject Barber",
  email: rejectBarberEmail,
  password: PASS,
  role: "barber",
  phone: "5550200003",
  shopName: `RV Reject Shop ${TS}`,
  address: "300 QA Blvd",
  city: "DC",
  state: "MD",
});
record("signup", "reject-candidate-register", rejectReg.res.ok, barberEmail);

// --- Super Admin workflow ---
const admin = await adminLogin();
let barberRowId = null;
let shopRowId = null;

if (!admin.token) {
  record("admin", "super-admin-login", false, admin.reason);
  record("admin", "pending-barber-in-dashboard", false, "skipped — no admin token");
  record("admin", "pending-shop-in-dashboard", false, "skipped — no admin token");
  record("admin", "approve-barber", false, "skipped");
  record("admin", "reject-barber", false, "skipped");
  record("admin", "approve-shop", false, "skipped");
  record("admin", "signup-audit", false, "skipped");
  record("email", "barber-approved-user-email", false, "skipped — no admin token");
  record("email", "barber-denied-user-email", false, "skipped — no admin token");
  record("email", "owner-approved-user-email", false, "skipped — no admin token");
} else {
  record("admin", "super-admin-login", true, admin.email);

  const audit = await jsonFetch(`${apiBase}/api/admin/barbers/signup-audit`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  record(
    "admin",
    "signup-audit",
    audit.res.ok && audit.data?.audit != null,
    `orphans=${audit.data?.audit?.orphanRegistrations ?? "?"} barbers=${audit.data?.audit?.totalBarberRows ?? "?"}`,
  );

  const barbersList = await jsonFetch(`${apiBase}/api/admin/barbers`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  const allBarbers = barbersFromListPayload(barbersList.data);
  const pendingBarbers = allBarbers.filter(
    (b) =>
      String(b.verificationStatus || b.verification_status || "").toLowerCase() === "pending" ||
      String(b.accountStatus || b.account_status || "").toLowerCase() === "pending",
  );
  const foundBarber = allBarbers.find(
    (b) => String(b.email || b.userEmail || "").toLowerCase() === barberEmail.toLowerCase(),
  );
  const foundReject = allBarbers.find(
    (b) => String(b.email || b.userEmail || "").toLowerCase() === rejectBarberEmail.toLowerCase(),
  );
  barberRowId = foundBarber?.id;
  record(
    "admin",
    "pending-barber-in-dashboard",
    Boolean(foundBarber),
    foundBarber ? `id=${foundBarber.id}` : `not in ${allBarbers.length} barbers`,
  );
  record(
    "admin",
    "dashboard-pending-count",
    pendingBarbers.length > 0,
    `${pendingBarbers.length} pending barber(s) listed`,
  );

  const shopsList = await jsonFetch(`${apiBase}/api/admin/shops`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  const foundShop = (shopsList.data?.shops || []).find((s) =>
    String(s.name || s.shopName || "").includes(`RV Business ${TS}`),
  );
  shopRowId = foundShop?.id;
  const pendingShops = (shopsList.data?.shops || []).filter(
    (s) => String(s.approvalStatus || s.approval_status || "").toLowerCase() === "pending",
  );
  record(
    "admin",
    "pending-shop-in-dashboard",
    Boolean(foundShop),
    foundShop ? `id=${foundShop.id}` : `not in ${shopsList.data?.shops?.length || 0} shops`,
  );
  record(
    "admin",
    "dashboard-pending-shops",
    pendingShops.length > 0,
    `${pendingShops.length} pending shop(s) listed`,
  );

  if (barberRowId) {
    const v = await jsonFetch(`${apiBase}/api/admin/barbers/${barberRowId}/verification`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    const a = await jsonFetch(`${apiBase}/api/admin/barbers/${barberRowId}/account-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    record("admin", "approve-barber", v.res.ok && a.res.ok, `verification=${v.res.status} account=${a.res.status}`);
    recordEmailDelivered(
      "email",
      "barber-approved-user-email",
      v.data?.userEmailSent,
      v.data?.userEmailMessageId,
      "check barber inbox",
    );
  }

  if (foundReject?.id) {
    const rj = await jsonFetch(`${apiBase}/api/admin/barbers/${foundReject.id}/verification`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    record("admin", "reject-barber", rj.res.ok, `status ${rj.res.status}`);
    recordEmailDelivered(
      "email",
      "barber-denied-user-email",
      rj.data?.userEmailSent,
      rj.data?.userEmailMessageId,
      "check reject barber inbox",
    );

    const afterRejectList = await jsonFetch(`${apiBase}/api/admin/barbers`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const rejectRow = barbersFromListPayload(afterRejectList.data).find(
      (b) => String(b.email || b.userEmail || "").toLowerCase() === rejectBarberEmail.toLowerCase(),
    );
    record(
      "admin",
      "dashboard-updates-after-deny",
      String(rejectRow?.verificationStatus || rejectRow?.verification_status || "").toLowerCase() === "rejected",
      `verification=${rejectRow?.verificationStatus || rejectRow?.verification_status || "?"}`,
    );
  }

  if (shopRowId) {
    const sa = await jsonFetch(`${apiBase}/api/admin/shops/${shopRowId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "free" }),
    });
    record("admin", "approve-shop", sa.res.ok, `status ${sa.res.status}`);
    recordEmailDelivered(
      "email",
      "owner-approved-user-email",
      Array.isArray(sa.data?.userEmailsSent) && sa.data.userEmailsSent.length > 0,
      sa.data?.userEmailMessageIds?.[0],
      "check shop owner inbox",
    );

    const afterShopList = await jsonFetch(`${apiBase}/api/admin/shops`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const approvedShop = (afterShopList.data?.shops || []).find((s) => String(s.id) === String(shopRowId));
    record(
      "admin",
      "dashboard-updates-after-approve-shop",
      String(approvedShop?.approvalStatus || approvedShop?.approval_status || "").toLowerCase() === "approved",
      `approval=${approvedShop?.approvalStatus || approvedShop?.approval_status || "?"}`,
    );
  }

  if (barberRowId) {
    const afterApproveList = await jsonFetch(`${apiBase}/api/admin/barbers`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const approvedRow = barbersFromListPayload(afterApproveList.data).find(
      (b) => String(b.id) === String(barberRowId),
    );
    record(
      "admin",
      "dashboard-updates-after-approve-barber",
      String(approvedRow?.verificationStatus || approvedRow?.verification_status || "").toLowerCase() === "approved",
      `verification=${approvedRow?.verificationStatus || approvedRow?.verification_status || "?"}`,
    );
  }
}

// --- Post-approval / rejection login ---
const barberPendingLogin = await loginUser(barberEmail, PASS, signupBase);
if (barberPendingLogin.data?.token) {
  const me = await authMe(barberPendingLogin.data.token, signupBase);
  record(
    "signup",
    "barber-pending-via-me",
    me.data?.user?.approvalStatus === "pending" || me.data?.approvalPending,
    `approval=${me.data?.user?.approvalStatus} limited=${me.data?.user?.limitedAccess}`,
  );
} else {
  record("signup", "barber-pending-via-me", false, "login failed");
}

const approvedLogin = await loginUser(barberEmail, PASS, signupBase);
if (approvedLogin.data?.token) {
  const me = await authMe(approvedLogin.data.token, signupBase);
  const approved =
    me.data?.user?.approvalStatus === "approved" ||
    me.data?.user?.limitedAccess === false ||
    me.data?.approvalPending === false;
  record(
    "signup",
    "approved-barber-login",
    approved && me.data?.user?.role === "barber",
    `role=${me.data?.user?.role} approval=${me.data?.user?.approvalStatus} limited=${me.data?.user?.limitedAccess}`,
  );
} else {
  record("signup", "approved-barber-login", false, "login failed");
}

const rejectLogin = await loginUser(rejectBarberEmail, PASS, signupBase);
if (rejectLogin.data?.token) {
  const me = await authMe(rejectLogin.data.token, signupBase);
  const restricted =
    me.data?.user?.limitedAccess === true ||
    me.data?.user?.approvalStatus === "rejected" ||
    (admin.token && me.data?.user?.approvalStatus === "rejected");
  record(
    "signup",
    "rejected-barber-restricted",
    restricted,
    `approval=${me.data?.user?.approvalStatus} limited=${me.data?.user?.limitedAccess}`,
  );
} else {
  record("signup", "rejected-barber-restricted", false, "login failed");
}

const ownerLogin = await loginUser(ownerEmail, PASS, signupBase);
if (ownerLogin.data?.token) {
  const me = await authMe(ownerLogin.data.token, signupBase);
  const ownerApproved =
    admin.token &&
    (me.data?.user?.approvalStatus === "approved" || me.data?.user?.limitedAccess === false);
  record(
    "signup",
    "owner-role-after-approval",
    me.data?.user?.role === "shop_owner",
    `role=${me.data?.user?.role} approval=${me.data?.user?.approvalStatus}`,
  );
  record(
    "signup",
    "approved-owner-access",
    !admin.token || ownerApproved,
    admin.token
      ? `approval=${me.data?.user?.approvalStatus} limited=${me.data?.user?.limitedAccess}`
      : "skipped — approve step not run",
  );
}

// --- Production booking (current deploy — single service baseline) ---
{
  const health = await jsonFetch(`${apiBase}/api/app-bookings/health`);
  record("booking-prod", "checkout-health", health.res.ok, `status ${health.res.status}`);

  const barbers = await jsonFetch(`${apiBase}/api/app-bookings/barbers`);
  const barber = (barbers.data?.barbers || barbers.data || []).find?.((b) => b?.name) || null;
  if (barber?.name) {
    const slots = await jsonFetch(
      `${apiBase}/api/app-bookings/available-slots?barberName=${encodeURIComponent(barber.name)}&dateLabel=Today`,
    );
    const list = slots.data?.slots || [];
    record(
      "booking-prod",
      "available-slots-live",
      slots.res.ok && list.length > 0,
      `${list.length} slots returned`,
    );
    const hasReasonField = list.some((s) => "available" in s && "reason" in s);
    record(
      "booking-prod",
      "slot-available-flag",
      hasReasonField || list.every((s) => "available" in s),
      hasReasonField ? "includes reason for unavailable" : "available boolean present",
    );
  } else {
    record("booking-prod", "available-slots-live", false, "no barber for slot test");
  }

  const startGate = await jsonFetch(`${apiBase}/api/app-bookings/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      barberName: barber?.name || "Chris",
      dateLabel: "Today",
      timeLabel: "10:00 AM",
      serviceId: 1,
      redirectUri: "https://ifcdcbarbersapp.com/booking",
    }),
  });
  record(
    "booking-prod",
    "checkout-requires-email",
    startGate.data?.error === "customer_email_required",
    startGate.data?.error || startGate.res.status,
  );
}

// --- Local booking WIP (multi-service + duration param) ---
if (localBase) {
  try {
    const health = await jsonFetch(`${localBase}/api/app-bookings/health`);
    record("booking-local", "local-server-health", health.res.ok, `status ${health.res.status}`);

    const barbers = await jsonFetch(`${localBase}/api/app-bookings/barbers`);
    const barber = barbersFromListPayload(barbers.data)[0];
    if (barber?.name) {
      const short = await jsonFetch(
        `${localBase}/api/app-bookings/available-slots?barberName=${encodeURIComponent(barber.name)}&dateLabel=Today&durationMinutes=30`,
      );
      const long = await jsonFetch(
        `${localBase}/api/app-bookings/available-slots?barberName=${encodeURIComponent(barber.name)}&dateLabel=Today&durationMinutes=90`,
      );
      const open30 = (short.data?.slots || []).filter((s) => s.available).length;
      const open90 = (long.data?.slots || []).filter((s) => s.available).length;
      record(
        "booking-local",
        "duration-reduces-open-slots",
        open90 <= open30,
        `30min=${open30} open, 90min=${open90} open`,
      );

      const services = await jsonFetch(
        `${localBase}/api/app-bookings/services?barberName=${encodeURIComponent(barber.name)}`,
      );
      const svcList = Array.isArray(services.data) ? services.data : services.data?.services || [];
      const serviceIds = svcList.slice(0, 2).map((s) => s.id).filter(Boolean);
      const pickSlot = (short.data?.slots || []).find((s) => s.available);
      const timeLabel = pickSlot?.label || pickSlot?.time || "10:00 AM";

      const startMulti = await jsonFetch(`${localBase}/api/app-bookings/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barberName: barber.name,
          barberId: barber.id,
          dateLabel: "Today",
          timeLabel,
          serviceIds: serviceIds.length ? serviceIds : [1],
          redirectUri: "https://ifcdcbarbersapp.com/booking",
          customerEmail: `qa-${TS}@gmail.com`,
          customerName: "QA Multi",
        }),
      });
      record(
        "booking-local",
        "multi-service-start",
        startMulti.res.ok || startMulti.data?.error === "slot_unavailable" || startMulti.data?.orderId,
        startMulti.data?.error || (startMulti.data?.orderId ? "order created" : startMulti.res.status),
      );
    }
  } catch (e) {
    record("booking-local", "local-server", false, e?.message || String(e));
  }
} else {
  record(
    "booking-local",
    "duration-slots-api",
    false,
    "skipped — run with --local-port=3099 after `PORT=3099 node server.js`",
  );
  record("booking-local", "multi-service-checkout", false, "skipped — requires local server");
}

// --- Regression: styles, photos, existing data ---
{
  const bookingEmailDiff = await import("node:child_process").then(({ execSync }) =>
    execSync("git diff --name-only bookingEmail.cjs emailResend.cjs paypalWebhookEmail.cjs 2>/dev/null || true", {
      cwd: root,
      encoding: "utf8",
    }),
  );
  record(
    "regression",
    "booking-email-stack-unchanged",
    !bookingEmailDiff.trim(),
    bookingEmailDiff.trim() || "bookingEmail.cjs / emailResend.cjs untouched",
  );
}

{
  const styles = await jsonFetch(`${apiBase}/api/styles`);
  const styleList = Array.isArray(styles.data) ? styles.data : styles.data?.styles || [];
  const priced = styleList.filter((s) => s?.price != null || s?.price_cents != null);
  record(
    "regression",
    "styles-pricing-public",
    styles.res.ok && priced.length > 0,
    `${priced.length} published style(s) with pricing`,
  );

  const withPhotos = styleList.filter((s) => s?.image || s?.photo || s?.image_url);
  record(
    "regression",
    "styles-photos-public",
    withPhotos.length > 0,
    `${withPhotos.length} style(s) with photos`,
  );
}

{
  const health = await jsonFetch(`${apiBase}/health`);
  record(
    "regression",
    "deploy-health",
    health.res.ok,
    health.data?.commit ? `commit ${String(health.data.commit).slice(0, 8)}` : `status ${health.res.status}`,
  );
}

// --- RLS unchanged ---
{
  const rlsPath = path.join(root, "src/db/supabase_rls_lockdown.sql");
  const rls = fs.readFileSync(rlsPath, "utf8");
  record(
    "security",
    "rls-lockdown-doc-present",
    rls.includes("ENABLE ROW LEVEL SECURITY") && rls.includes("app_users"),
    "supabase_rls_lockdown.sql intact",
  );
  const gitDiff = await import("node:child_process").then(({ execSync }) =>
    execSync("git diff --name-only src/db/ rolePolicy.js 2>/dev/null || true", {
      cwd: root,
      encoding: "utf8",
    }),
  );
  record(
    "security",
    "no-rls-auth-regression-in-diff",
    !gitDiff.trim(),
    gitDiff.trim() || "no RLS / rolePolicy files in uncommitted diff",
  );
}

// --- Summary ---
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n=== Summary: ${passed}/${results.length} passed ===`);
if (failed.length) {
  console.log("\nFailed / skipped:");
  for (const f of failed) console.log(`  - [${f.section}] ${f.id}: ${f.detail}`);
}
console.log("\nTest accounts (delete after QA):");
console.log(`  Barber (approve): ${barberEmail}`);
console.log(`  Barber (reject):  ${rejectBarberEmail}`);
console.log(`  Shop owner:       ${ownerEmail}`);
console.log(`  Password:         ${PASS}\n`);

process.exit(failed.length ? 1 : 0);
