#!/usr/bin/env node
/**
 * Login MFA is disabled by default. These checks guard against accidental reintroduction.
 *
 *   node --import ./loadBackendEnv.mjs scripts/test-super-admin-sms-verify-handoff.mjs
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const challenge = readFileSync(join(root, "superAdminLoginChallenge.cjs"), "utf8");
assert.match(challenge, /SUPER_ADMIN_LOGIN_STEPUP \?\? "0"/);
console.log("[handoff] PASS — Super Admin login step-up defaults OFF");

const apiSrc = readFileSync(join(root, "mobile/auth/authSessionApi.ts"), "utf8");
const loginFn = apiSrc.slice(apiSrc.indexOf("export async function loginWithEmailPassword"));
assert.doesNotMatch(loginFn, /requiresVerification/);
assert.doesNotMatch(loginFn, /verificationChannel|preferSms/);
console.log("[handoff] PASS — mobile login API is email/password only");

const loginSrc = readFileSync(join(root, "mobile/screens/LoginScreen.tsx"), "utf8");
assert.doesNotMatch(loginSrc, /needsVerification|verificationCode|verificationHint/);
assert.match(loginSrc, /signInWithToken\(result\.token\)/);
console.log("[handoff] PASS — LoginScreen has no verification-code UI");

const webLogin = readFileSync(join(root, "client/src/pages/Login.jsx"), "utf8");
assert.doesNotMatch(webLogin, /needsVerification|verificationCode/);
console.log("[handoff] PASS — web Login has no verification-code UI");

const password = String(
  process.env.SUPER_ADMIN_PASSWORD ||
    process.env.SA_LOGIN_PASSWORD ||
    process.env.TEST_SUPER_ADMIN_PASSWORD ||
    "",
).trim();

if (!password) {
  console.log(
    JSON.stringify({
      liveLogin: "skipped",
      reason: "no_password_env",
      note: "Set SUPER_ADMIN_PASSWORD to exercise Super Admin login without MFA.",
    }),
  );
  process.exit(0);
}

delete process.env.SUPER_ADMIN_LOGIN_STEPUP;

const { createAuthRouter } = await import("../authRoutes.js");
const router = createAuthRouter({ sendEmail: async () => ({ ok: true }) });
const layer = router.stack.find((l) => l?.route?.path === "/login" && l.route?.methods?.post);
const login = layer?.route?.stack?.[0]?.handle;
assert.equal(typeof login, "function", "POST /login handler missing");

const out = { statusCode: 200, body: null };
const res = {
  status(code) {
    out.statusCode = code;
    return this;
  },
  json(body) {
    out.body = body;
    return this;
  },
};

await login(
  {
    body: {
      email: process.env.SUPER_ADMIN_EMAIL || "service@ifcdc.org",
      password,
    },
    ip: "127.0.0.1",
    headers: {},
    get() {
      return "";
    },
  },
  res,
);

console.log(
  JSON.stringify(
    {
      liveLogin: true,
      http: out.statusCode,
      ok: out.body?.ok,
      success: out.body?.success,
      requiresVerification: out.body?.requiresVerification,
      hasToken: Boolean(out.body?.token),
      hasUser: Boolean(out.body?.user),
      error: out.body?.error || null,
    },
    null,
    2,
  ),
);

assert.equal(out.statusCode, 200, "Super Admin login must succeed without MFA");
assert.notEqual(out.body?.requiresVerification, true);
assert.ok(out.body?.token, "must issue session token");
assert.ok(out.body?.user, "must return user");
console.log("[handoff] PASS — Super Admin email/password → token when step-up disabled");
