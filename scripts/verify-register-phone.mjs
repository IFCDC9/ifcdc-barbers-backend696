#!/usr/bin/env node
/** Verify signup phone validation on production API (no accounts created). */
import { validateSignupPhone } from "../phoneValidation.js";

const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/$/, "");

let failed = 0;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failed++;
}
function ok(msg) {
  console.log(`OK    ${msg}`);
}

console.log(`\nRegister phone validation → ${base}\n`);

ok(`local validate empty: ${validateSignupPhone("").ok === false}`);
ok(`local validate short: ${validateSignupPhone("123").ok === false}`);
ok(`local validate US: ${validateSignupPhone("5551234567").display === "(555) 123-4567"}`);

async function postRegister(body) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

const missingPhone = await postRegister({
  name: "Test User",
  email: `probe-${Date.now()}@example.invalid`,
  password: "ProbeTest!234567",
  accountType: "user",
});
if (missingPhone.res.status === 400 && missingPhone.json.error === "phone_required") {
  ok("customer signup without phone returns phone_required");
} else {
  fail(`customer without phone: expected phone_required, got ${missingPhone.res.status} ${missingPhone.json.error || ""}`);
}

const invalidPhone = await postRegister({
  name: "Test User",
  email: `probe-${Date.now()}@example.invalid`,
  password: "ProbeTest!234567",
  accountType: "user",
  phone: "123",
});
if (invalidPhone.res.status === 400 && invalidPhone.json.error === "phone_invalid") {
  ok("customer signup with invalid phone returns phone_invalid");
} else {
  fail(`invalid phone: expected phone_invalid, got ${invalidPhone.res.status} ${invalidPhone.json.error || ""}`);
}

if (failed) process.exit(1);
console.log("\nAll register phone checks passed.\n");
