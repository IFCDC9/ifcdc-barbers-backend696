#!/usr/bin/env node
/**
 * Run all automated Build 44 regression checks (no device, no live PayPal charge).
 * Usage: node scripts/verify-build44-automated.mjs [--base URL]
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const SCRIPTS = [
  "verify-phase2-complete.mjs",
  "verify-v2-quality.mjs",
  "verify-phase1-portfolio.mjs",
  "verify-service-photo-workflow.mjs",
  "verify-public-domains.mjs",
  "verify-password-reset-flow.mjs",
  "verify-supabase-production.mjs",
  "verify-booking-email-gate.mjs",
  "verify-platform-fee-checkout.mjs",
  "verify-payment-flow-audit.mjs",
  "verify-e2e-payment-audit.mjs",
  "verify-profile-patch.mjs",
];

console.log(`\n=== Build 44 automated regression ===\nAPI: ${base}\n`);

let failed = 0;
for (const script of SCRIPTS) {
  const label = script.replace(".mjs", "");
  process.stdout.write(`${label} … `);
  try {
    execSync(`node scripts/${script}`, {
      cwd: ROOT,
      env: { ...process.env, API_BASE: base },
      stdio: "pipe",
    });
    console.log("PASS");
  } catch (e) {
    failed++;
    console.log("FAIL");
    const err = e.stderr?.toString?.() || e.stdout?.toString?.() || e.message;
    console.error(err.split("\n").slice(-6).join("\n"));
  }
}

async function probe(pathname, { method = "GET", body, expectStatus } = {}) {
  const url = `${base.replace(/\/+$/, "")}${pathname}`;
  const init = { method, headers: { Accept: "application/json" } };
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  const ok = expectStatus ? res.status === expectStatus : res.ok;
  return { ok, status: res.status, json };
}

console.log("\nProduction probes:");
const probes = [
  ["deploy commit 6a48ed56 / f76e1f2b", async () => {
    const { ok, json } = await probe("/api/deploy-info");
    const s = json.activeCommitShort || "";
    return { ok: ok && (s.startsWith("6a48ed") || s.startsWith("f76e1f")), detail: s };
  }],
  ["PATCH /api/auth/profile secured", async () => {
    const { status } = await probe("/api/auth/profile", { method: "PATCH", body: {}, expectStatus: 401 });
    return { ok: status === 401, detail: `HTTP ${status}` };
  }],
  ["Discover feed", async () => {
    const { ok, json } = await probe("/api/portfolio/discover?limit=5");
    return { ok: ok && json.ok, detail: `${(json.photos || []).length} photos` };
  }],
  ["Portfolio service covers", async () => {
    const { ok, json } = await probe("/api/portfolio/ifcdc-barbers");
    const svc = json.portfolio?.services || [];
    const all = svc.length > 0 && svc.every((s) => String(s.imageUrl || "").startsWith("https://"));
    return { ok: ok && all, detail: `${svc.length} services` };
  }],
  ["AURA chat", async () => {
    const { ok, json } = await probe("/api/aura/chat", { method: "POST", body: { message: "hello", locale: "en" } });
    return { ok: ok && Boolean(json.reply), detail: ok ? "reply ok" : "no reply" };
  }],
  ["Email health", async () => {
    const { ok, json } = await probe("/api/email/health");
    return { ok: ok && json.ok, detail: json.provider || "—" };
  }],
  ["Storage health", async () => {
    const { ok, json } = await probe("/api/storage-health");
    return { ok: ok && json.ok, detail: "ok" };
  }],
];

for (const [name, fn] of probes) {
  process.stdout.write(`${name} … `);
  try {
    const { ok, detail } = await fn();
    if (!ok) failed++;
    console.log(ok ? `PASS (${detail})` : `FAIL (${detail})`);
  } catch (e) {
    failed++;
    console.log(`FAIL (${e.message})`);
  }
}

console.log(`\n${failed === 0 ? "All automated Build 44 checks passed." : `${failed} check(s) failed.`}\n`);
process.exit(failed > 0 ? 1 : 0);
