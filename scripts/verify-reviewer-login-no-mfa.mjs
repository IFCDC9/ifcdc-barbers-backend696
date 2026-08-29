#!/usr/bin/env node
/**
 * Confirms store-review login is email/password only (no MFA step).
 *
 *   node scripts/verify-reviewer-login-no-mfa.mjs
 *   API_ORIGIN=https://ifcdc-barbers-backend696.onrender.com node scripts/verify-reviewer-login-no-mfa.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let review = {};
try {
  const storeConfig = JSON.parse(readFileSync(join(root, "mobile/store.config.json"), "utf8"));
  review = storeConfig?.apple?.review || storeConfig?.android?.review || storeConfig?.review || {};
} catch {
  /* store.config.json may be mid-edit; fall back to env or known review credentials */
}

const email = String(
  process.env.REVIEWER_EMAIL || review.demoUsername || "apple.review@ifcdcbarbersapp.com",
).trim();
const password = String(process.env.REVIEWER_PASSWORD || review.demoPassword || "IFCDC-Review2026!").trim();
const origin = String(process.env.API_ORIGIN || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/+$/,
  "",
);

assert.ok(email, "reviewer email missing (store.config.json demoUsername or REVIEWER_EMAIL)");
assert.ok(password, "reviewer password missing (store.config.json demoPassword or REVIEWER_PASSWORD)");

const res = await fetch(`${origin}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const text = await res.text();
let body = {};
try {
  body = text ? JSON.parse(text) : {};
} catch {
  throw new Error(`Non-JSON login response (HTTP ${res.status}): ${text.slice(0, 200)}`);
}

const summary = {
  origin,
  email,
  http: res.status,
  requiresVerification: body.requiresVerification === true,
  hasToken: Boolean(body.token),
  role: body?.user?.role || null,
  error: body.error || null,
  message: String(body.message || "").slice(0, 120) || null,
};

console.log(JSON.stringify(summary, null, 2));

assert.equal(res.status, 200, `expected HTTP 200, got ${res.status}`);
assert.notEqual(body.requiresVerification, true, "login must not require verification code");
assert.ok(body.token, "login must return a session token");
assert.ok(body.user?.email, "login must return user payload");
console.log("[reviewer-login] PASS — email/password → token, no MFA");
