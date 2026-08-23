#!/usr/bin/env node
/**
 * Handoff tests for Super Admin SMS verify → session.
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

const apiSrc = readFileSync(join(root, "mobile/auth/authSessionApi.ts"), "utf8");
const loginFn = apiSrc.slice(apiSrc.indexOf("export async function loginWithEmailPassword"));
const tokenPos = loginFn.indexOf("loginResponseSucceeded(status, json)");
const reqPos = loginFn.indexOf("json?.requiresVerification === true");
assert.ok(tokenPos >= 0 && reqPos >= 0 && tokenPos < reqPos, "client must prefer token over requiresVerification");
console.log("[handoff] PASS — mobile client prefers token over requiresVerification");

const loginSrc = readFileSync(join(root, "mobile/screens/LoginScreen.tsx"), "utf8");
assert.match(loginSrc, /submittedCode/);
assert.match(loginSrc, /codeSentSms|Verification code sent by text/);
assert.match(loginSrc, /signInWithToken\(result\.token\)/);
console.log("[handoff] PASS — LoginScreen verify→session wiring present");

const authCtx = readFileSync(join(root, "mobile/services/authContext.tsx"), "utf8");
assert.match(authCtx, /applySession\(normalized,\s*null\)/);
const appRoot = readFileSync(join(root, "mobile/AppRoot.tsx"), "utf8");
assert.match(appRoot, /key=\{token \? "app" : "auth"\}/);
console.log("[handoff] PASS — AuthGate + immediate session apply present");

const authRoutes = readFileSync(join(root, "authRoutes.js"), "utf8");
assert.match(authRoutes, /never issued|do not fall through|verificationFailed:\s*true/);
assert.match(authRoutes, /requiresVerification:\s*false/);
console.log("[handoff] PASS — backend verify handoff guards present");

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
      note: "Set SUPER_ADMIN_PASSWORD to exercise DB login + mocked Verify → token.",
    }),
  );
  process.exit(0);
}

const verifyPath = require.resolve("../smsVerifyService.cjs");
const realVerify = require(verifyPath);
require.cache[verifyPath].exports = {
  ...realVerify,
  async checkSmsVerification() {
    return { ok: true, e164: "+18484694448", status: "approved" };
  },
  async startSmsVerification() {
    throw new Error("startSmsVerification must not run during code-verify handoff");
  },
};

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
      verificationCode: "123456",
      channel: "sms",
      verificationChannel: "sms",
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

assert.equal(out.statusCode, 200, "mocked Verify approval must yield HTTP 200");
assert.equal(out.body?.requiresVerification, false);
assert.ok(out.body?.token, "must issue session token");
assert.ok(out.body?.user, "must return user");
console.log("[handoff] PASS — mocked SMS verify → token session");
process.exit(0);
