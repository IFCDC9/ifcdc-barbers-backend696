#!/usr/bin/env node
/**
 * AURA Phase 2 flags-off baseline smoke (read-mostly).
 * Usage: node scripts/smoke-aura-phase2-flags-off.mjs
 */
const API = String(process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const WEB = String(process.env.PUBLIC_WEB_URL || "https://ifcdcbarbersapp.com").replace(/\/$/, "");
const AURA_HOST = String(process.env.AURA_PUBLIC_BASE_URL || "https://aura.ifcdcbarbersapp.com").replace(
  /\/$/,
  "",
);

async function get(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { url, status: r.status, ok: r.ok, json, textSnippet: text.slice(0, 160) };
}

async function post(url, body) {
  return get(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const out = { checkedAt: new Date().toISOString(), api: API, checks: {} };

out.checks.health = await get(`${API}/api/health`);
out.checks.deploy = await get(`${API}/api/deploy-info`);
out.checks.phase2Status = await get(`${API}/api/aura/phase2/status`);
out.checks.auraStatus = await get(`${API}/api/aura/status`);
out.checks.barbers = await get(`${API}/api/barbers`);
out.checks.config = await get(`${API}/api/config`);
out.checks.website = await get(`${WEB}/`);
out.checks.auraDomain = await get(`${AURA_HOST}/`);

const barberId = out.checks.barbers.json?.barbers?.[0]?.id || 1;
const ymd = new Date().toISOString().slice(0, 10);
out.checks.slots = await get(
  `${API}/api/barbers/${encodeURIComponent(barberId)}/available-slots?date=${ymd}`,
);
out.checks.styles = await get(`${API}/api/styles`);

// Auth negative path (proves route alive without using real credentials)
out.checks.loginBadPassword = await post(`${API}/api/auth/login`, {
  email: "smoke-nonexistent@example.com",
  password: "definitely-wrong-password",
});

// PayPal readiness (no capture)
out.checks.paypalClient =
  (await get(`${API}/api/payments/paypal-client-id`).catch(() => null)) ||
  (await get(`${API}/api/paypal/client-id`).catch(() => null)) ||
  { status: 0, note: "endpoint_probe_fallback" };
if (!out.checks.paypalClient?.status) {
  out.checks.paypalClient = await get(`${API}/api/config`);
}

const deploy = out.checks.deploy.json || {};
const summary = {
  checkedAt: out.checkedAt,
  activeCommit: deploy.activeCommit || null,
  activeCommitShort: deploy.activeCommitShort || null,
  healthOk: out.checks.health.json?.status === "OK",
  phase2Http: out.checks.phase2Status.status,
  phase2DisabledAsExpected:
    out.checks.phase2Status.status === 404 ||
    out.checks.phase2Status.json?.error === "aura_phase2_disabled",
  websiteHttp: out.checks.website.status,
  auraDomainHttp: out.checks.auraDomain.status,
  barbersOk: Boolean(out.checks.barbers.json?.ok),
  barberCount: (out.checks.barbers.json?.barbers || []).length,
  slotsHttp: out.checks.slots.status,
  slotCount: Array.isArray(out.checks.slots.json?.slots)
    ? out.checks.slots.json.slots.length
    : Array.isArray(out.checks.slots.json?.available)
      ? out.checks.slots.json.available.length
      : null,
  stylesHttp: out.checks.styles.status,
  loginRouteAlive: [400, 401, 403, 404].includes(out.checks.loginBadPassword.status) === false
    ? out.checks.loginBadPassword.status
    : out.checks.loginBadPassword.status,
  loginRejectedInvalidUser: [400, 401, 403, 404].includes(out.checks.loginBadPassword.status),
  paypalClientConfigured: Boolean(
    out.checks.config.json?.paypalClientId ||
      out.checks.config.json?.paypal?.clientId ||
      out.checks.paypalClient.json?.clientId ||
      out.checks.paypalClient.json?.paypalClientId,
  ),
  mailFromUnchangedHint: "not modified by Phase 2 deploy",
};

console.log(JSON.stringify({ summary, raw: {
  health: out.checks.health.json,
  phase2: { status: out.checks.phase2Status.status, body: out.checks.phase2Status.json },
  slotsKeys: out.checks.slots.json ? Object.keys(out.checks.slots.json).slice(0, 12) : null,
  loginStatus: out.checks.loginBadPassword.status,
  loginBody: out.checks.loginBadPassword.json,
  configPaypalHints: out.checks.config.json
    ? Object.keys(out.checks.config.json).filter((k) => /paypal|mail|resend/i.test(k))
    : null,
} }, null, 2));

const hardFail = !(
  summary.healthOk &&
  summary.phase2DisabledAsExpected &&
  summary.websiteHttp === 200 &&
  summary.barbersOk &&
  String(summary.activeCommitShort || "").startsWith("169ac4a2")
);
process.exit(hardFail ? 1 : 0);
