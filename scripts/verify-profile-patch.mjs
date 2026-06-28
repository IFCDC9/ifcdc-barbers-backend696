#!/usr/bin/env node
/**
 * Verify PATCH /api/auth/profile is registered and rejects unauthenticated calls.
 * Usage: node scripts/verify-profile-patch.mjs [--base URL]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const url = `${base.replace(/\/+$/, "")}/api/auth/profile`;

const res = await fetch(url, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ name: "Verify Test" }),
});
const text = await res.text();
let json = {};
try {
  json = text ? JSON.parse(text) : {};
} catch {
  json = { raw: text.slice(0, 200) };
}

console.log(`PATCH ${url} → HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));

if (res.status === 404) {
  console.error("\nFAIL: PATCH /api/auth/profile returned 404 (route not mounted).\n");
  process.exit(1);
}
if (res.status !== 401) {
  console.error(`\nFAIL: expected 401 without token, got ${res.status}\n`);
  process.exit(1);
}
console.log("\nOK  PATCH /api/auth/profile route is live and requires auth.\n");
