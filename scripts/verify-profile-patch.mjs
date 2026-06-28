#!/usr/bin/env node
/**
 * Verify PATCH /api/auth/profile is registered and secured.
 * Usage: node scripts/verify-profile-patch.mjs [--base URL]
 */
const base =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com";

const url = `${base.replace(/\/+$/, "")}/api/auth/profile`;

const unauth = await fetch(url, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ name: "Test" }),
});

if (unauth.status !== 401) {
  console.error(`FAIL PATCH /api/auth/profile without token: expected 401, got ${unauth.status}`);
  process.exit(1);
}

console.log("OK  PATCH /api/auth/profile requires auth (401 without token)");
console.log(`    ${url}\n`);
