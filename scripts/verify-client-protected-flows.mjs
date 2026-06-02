#!/usr/bin/env node
/**
 * Pre-deploy checks for client protected flows (no DNS/deploy).
 * Usage: node scripts/verify-client-protected-flows.mjs [--api https://ifcdc-barbers-backend696.onrender.com]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");

const API =
  process.argv.find((a) => a.startsWith("--api="))?.slice(6) ||
  process.env.VITE_API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const checks = [];
let failed = 0;

function ok(name, detail = "") {
  checks.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  failed++;
  checks.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function mustInclude(rel, needles, label) {
  const text = read(rel);
  for (const n of needles) {
    if (!text.includes(n)) {
      fail(label || rel, `missing: ${n}`);
      return false;
    }
  }
  ok(label || rel, needles.join(", "));
  return true;
}

console.log("\n=== Client protected-flow verification ===\n");

// 1. Render UI baseline (entry + shell)
mustInclude("client/src/main.jsx", ["App.jsx", "PayPalScriptProvider"], "entry: main.jsx");
mustInclude("client/src/App.jsx", ["MainLayout", "app-container"], "Render UI: App.jsx shell");
mustInclude("client/package.json", ["vite", "@vitejs/plugin-react"], "build: vite in dependencies");

// 2. Protected logic files present
const protectedFiles = [
  "client/src/pages/Booking.jsx",
  "client/src/pages/Invite.jsx",
  "client/src/pages/Login.jsx",
  "client/src/lib/stylePricing.js",
  "client/src/components/PayPalReturnHandler.jsx",
  "client/src/components/PayPalReturnBridge.jsx",
  "client/src/routes/paymentFlowRoutes.jsx",
  "client/src/lib/api.js",
];
for (const f of protectedFiles) {
  if (fs.existsSync(path.join(ROOT, f))) ok(`file: ${f}`);
  else fail(`file: ${f}`, "missing");
}

// 3. App routes wired
mustInclude(
  "client/src/App.jsx",
  ["/invite", "/checkout", "/confirmation", "PayPalReturnBridge"],
  "routes: payment + invite + PayPal return"
);

// 4. PayPal + booking API strings
mustInclude("client/src/pages/Booking.jsx", ["capture-order", "/api/book", "computeChargeBreakdown"], "booking: PayPal + fees");
mustInclude("client/src/pages/Invite.jsx", ["/api/invite/validate", "/api/invite/accept"], "invite API");

// 5. Production build
try {
  execSync("npm run build", {
    cwd: CLIENT,
    env: { ...process.env, NODE_ENV: "production", VITE_API_BASE: API },
    stdio: "pipe",
  });
  ok("client build", "NODE_ENV=production");
} catch (e) {
  fail("client build", e.stderr?.toString?.()?.slice(-400) || String(e.message));
}

// 6. Backend696 smoke (read-only)
async function probe(url, label) {
  try {
    const r = await fetch(url, { method: "GET" });
    if (r.status < 500) ok(`API ${label}`, `HTTP ${r.status}`);
    else fail(`API ${label}`, `HTTP ${r.status}`);
  } catch (e) {
    fail(`API ${label}`, e.message);
  }
}

const base = API.replace(/\/$/, "");
await probe(`${base}/health`, "health");
await probe(`${base}/api/invite/validate?token=__test__`, "invite validate");

console.log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
console.log(`API base used: ${base}\n`);
process.exit(failed > 0 ? 1 : 0);
