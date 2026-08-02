#!/usr/bin/env node
/**
 * Controlled verification after AURA_PHASE2_ENABLED=true (subflags still false).
 */
const API696 = "https://ifcdc-barbers-backend696.onrender.com";
const AURA_BACKEND = "https://aura-backend.onrender.com";
const AURA_HOST = "https://aura.ifcdcbarbersapp.com";
const WEB = "https://ifcdcbarbersapp.com";

async function probe(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 25000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { url, status: r.status, ok: r.ok, json, text: text.slice(0, 240) };
  } catch (e) {
    return { url, status: 0, ok: false, error: e?.name === "AbortError" ? "timeout" : e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

function summarizeFlags(body) {
  if (!body || typeof body !== "object") return null;
  return body.flags || body;
}

const out = { checkedAt: new Date().toISOString(), hosts: {}, smoke: {}, subfeatures: {} };

for (const [name, base] of [
  ["backend696", API696],
  ["aura_backend", AURA_BACKEND],
  ["aura_custom_domain", AURA_HOST],
]) {
  out.hosts[name] = {
    health: await probe(`${base}/api/health`),
    deploy: await probe(`${base}/api/deploy-info`),
    phase2: await probe(`${base}/api/aura/phase2/status`),
    auraStatus: await probe(`${base}/api/aura/status`),
  };
}

out.smoke.website = await probe(`${WEB}/`);
out.smoke.bookingPage = await probe(`${WEB}/booking`);
out.smoke.paypalBookingPage = await probe(`${WEB}/paypal-booking`);
out.smoke.barbers = await probe(`${API696}/api/barbers`);
out.smoke.styles = await probe(`${API696}/api/styles`);
out.smoke.config = await probe(`${API696}/api/config`);
out.smoke.loginReject = await probe(`${API696}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "smoke-nonexistent@example.com", password: "wrong" }),
});

const bid = "3df86e72-8999-4633-bca7-2274b57b5b4f";
out.smoke.slots = await probe(
  `${API696}/api/app-bookings/available-slots?barberId=${encodeURIComponent(bid)}&date=2026-08-05&durationMinutes=40`,
);
out.smoke.finalizeInvalid = await probe(`${API696}/api/app-bookings/finalize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ orderID: "INVALID-SMOKE-ORDER" }),
});

// Subfeature disable proof via status payload when master on
for (const [name, host] of Object.entries(out.hosts)) {
  const p2 = host.phase2;
  out.subfeatures[name] = {
    http: p2.status,
    disabledEndpoint: p2.status === 404 && p2.json?.error === "aura_phase2_disabled",
    masterOn: p2.status === 200 && p2.json?.ok === true && p2.json?.flags?.master === true,
    flags: summarizeFlags(p2.json),
  };
}

console.log(JSON.stringify(out, null, 2));
