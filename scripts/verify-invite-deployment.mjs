#!/usr/bin/env node
/**
 * Post-deploy verification for invite web flow + domain routing.
 * Usage: node scripts/verify-invite-deployment.mjs
 */
const FRONTEND_RENDER = "https://ifcdc-barbers-frontend.onrender.com";
const BACKEND = "https://ifcdc-barbers-backend696.onrender.com";
const APEX = "https://ifcdcbarbersapp.com";
const WWW = "https://www.ifcdcbarbersapp.com";

async function fetchMeta(url, { method = "GET" } = {}) {
  try {
    const res = await fetch(url, { method, redirect: "follow" });
    const text = await res.text();
    const isHtml = /<!DOCTYPE html|<html/i.test(text);
    const isParking = /LANDER_SYSTEM|wsimg\.com\/parking|location\.href\s*=\s*["']\/lander/i.test(text);
    const isReact = /id="root"/i.test(text) && !isParking;
    const isJson = text.trim().startsWith("{");
    return {
      url,
      status: res.status,
      ok: res.ok,
      isHtml,
      isParking,
      isReact,
      isJson,
      preview: text.slice(0, 180).replace(/\s+/g, " "),
    };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

function pass(label, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== IFCDC invite deployment verification ===\n");

  const backendHealth = await fetchMeta(`${BACKEND}/health`);
  pass("Backend health", backendHealth.ok && backendHealth.isJson, backendHealth.preview);

  const inviteValidate = await fetchMeta(`${BACKEND}/api/invite/validate?token=test`);
  pass(
    "Backend invite validate route",
    inviteValidate.isJson && inviteValidate.preview.includes("invalid_or_expired"),
    inviteValidate.preview,
  );

  const renderFe = await fetchMeta(FRONTEND_RENDER);
  pass("Render frontend static site", renderFe.ok && renderFe.isReact, `HTTP ${renderFe.status}`);

  for (const [label, base] of [
    ["Apex homepage", APEX],
    ["WWW homepage", WWW],
    ["Apex /login", `${APEX}/login`],
    ["Apex /invite", `${APEX}/invite?token=test`],
  ]) {
    const r = await fetchMeta(base);
    if (r.isParking) pass(label, false, "GoDaddy parking/lander");
    else if (r.isReact) pass(label, true, `HTTP ${r.status}`);
    else pass(label, r.ok && !r.isParking, r.preview || `HTTP ${r.status}`);
  }

  if (renderFe.ok && renderFe.isReact) {
    for (const path of ["/", "/login", "/invite?token=test"]) {
      const r = await fetchMeta(`${FRONTEND_RENDER}${path}`);
      pass(`Render FE ${path}`, r.ok && r.isReact, `HTTP ${r.status}`);
    }
  }

  console.log("\nDNS (run locally): dig +short ifcdcbarbersapp.com A  # expect 216.24.57.1");
  console.log("DNS (run locally): dig +short www.ifcdcbarbersapp.com CNAME  # expect *.onrender.com");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
