import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  classifyPasswordResetSendError,
  isValidEmailFormat,
  userFacingForgotPasswordMessage,
  FORGOT_PASSWORD_USER_MESSAGES,
  NEUTRAL_SMS_FORGOT_MESSAGE,
  buildCustomerResetEmailHtml,
  requestPasswordResetForEmail,
  requestSmsPasswordReset,
  verifySmsPasswordResetCode,
  completePasswordResetWithToken,
  resetSmsPasswordResetLimits,
  hashSmsResetCode,
} from "../passwordResetService.js";
import { userFacingForgotPasswordError } from "../client/src/lib/forgotPasswordErrors.js";

const STRONG_PASSWORD = "CorrectHorse9!";

function createMockResetDb(seedUsers, assignmentSnapshot) {
  const rows = seedUsers.map((u) => ({ ...u }));
  const assignment = assignmentSnapshot ? { ...assignmentSnapshot } : null;
  const calls = [];
  async function dbQuery(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ");
    calls.push({ q, params });
    if (/UPDATE app_users/.test(q) && /apple_id\s*=/.test(q)) {
      throw new Error("must not update apple_id");
    }
    if (/management_assignments|linked_email|manager_shop_access|manager_location_access/.test(q)) {
      throw new Error("must not touch management tables");
    }
    if (q.includes("FROM app_users") && q.includes("lower(trim(email")) {
      const em = String(params[0] || "").toLowerCase();
      return { rows: rows.filter((u) => String(u.email).toLowerCase() === em).slice(0, 1) };
    }
    if (q.includes("FROM app_users") && q.includes("reset_token_hash =")) {
      return { rows: rows.filter((u) => u.reset_token_hash === params[0]).slice(0, 1) };
    }
    if (q.includes("SET password_hash")) {
      const [hash, id] = params;
      const u = rows.find((x) => x.id === id);
      if (u) {
        u.password_hash = hash;
        u.reset_token_hash = null;
        u.reset_token_expires_at = null;
      }
      return { rows: [] };
    }
    if (q.includes("SET reset_token_hash = NULL")) {
      const u = rows.find((x) => x.id === params[0]);
      if (u) {
        u.reset_token_hash = null;
        u.reset_token_expires_at = null;
      }
      return { rows: [] };
    }
    if (q.includes("SET reset_token_hash")) {
      const [hash, exp, id] = params;
      const u = rows.find((x) => x.id === id);
      if (u) {
        u.reset_token_hash = hash;
        u.reset_token_expires_at = exp;
      }
      return { rows: [] };
    }
    throw new Error(`unmocked sql: ${q}`);
  }
  return { dbQuery, rows, calls, assignment };
}

beforeEach(() => {
  resetSmsPasswordResetLimits();
});

test("isValidEmailFormat rejects empty and malformed", () => {
  assert.equal(isValidEmailFormat(""), false);
  assert.equal(isValidEmailFormat("not-an-email"), false);
  assert.equal(isValidEmailFormat("ok@example.com"), true);
});

test("requestPasswordResetForEmail rejects invalid email without sending", async () => {
  let sent = 0;
  const missing = await requestPasswordResetForEmail("", { sendEmail: async () => { sent += 1; return {}; } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "email_required");
  const bad = await requestPasswordResetForEmail("not-an-email", { sendEmail: async () => { sent += 1; return {}; } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "email_required");
  assert.equal(sent, 0);
});

test("classifyPasswordResetSendError maps Resend/config failures", () => {
  assert.equal(classifyPasswordResetSendError({ message: "MAIL_FROM not set" }), "email_unconfigured");
  assert.equal(classifyPasswordResetSendError({ message: "RESEND_API_KEY missing or invalid" }), "email_unconfigured");
  assert.equal(classifyPasswordResetSendError({ message: "429 rate limit" }), "email_rate_limited");
  assert.equal(classifyPasswordResetSendError({ message: "validation_error" }), "email_failed");
});

test("user-facing reset messages never echo tokens or raw provider errors", () => {
  assert.match(userFacingForgotPasswordMessage("email_failed"), /could not deliver/i);
  assert.equal(userFacingForgotPasswordMessage("email_failed").includes("re_"), false);
  assert.equal(FORGOT_PASSWORD_USER_MESSAGES.email_failed.includes("token"), false);
  assert.equal(
    userFacingForgotPasswordError({ code: "email_unconfigured", status: 503, message: "RESEND_API_KEY leaked" }),
    FORGOT_PASSWORD_USER_MESSAGES.email_unconfigured,
  );
  assert.equal(userFacingForgotPasswordError({ status: 429 }).includes("429"), false);
  assert.equal(userFacingForgotPasswordError({ code: "sms_failed", message: "Twilio 21211" }).includes("Twilio"), false);
  assert.equal(userFacingForgotPasswordError({ code: "sms_failed", message: "Twilio 21211" }).includes("21211"), false);
});

test("reset email HTML includes SPA reset path and no API host", () => {
  const html = buildCustomerResetEmailHtml({
    name: "Laketa",
    resetLink: "https://ifcdcbarbersapp.com/reset-password?token=sample",
  });
  assert.match(html, /reset-password\?token=sample/);
  assert.equal(html.includes("backend696"), false);
});

test("Apple user with verified phone receives mocked SMS and can set local password", async () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Apple Manager",
    email: "apple-phone@example.com",
    role: "user",
    account_status: "active",
    apple_id: "apple.sub.example",
    password_hash: "existing-hash",
    phone: null,
    phone_e164: "+15555550123",
    phone_verified: true,
    reset_token_hash: null,
    reset_token_expires_at: null,
  };
  const assignment = {
    role: "shop_manager",
    status: "active",
    linked_email: "apple-phone@example.com",
    shopRows: 1,
    locationRows: 1,
  };
  const db = createMockResetDb([user], assignment);
  let smsBodies = [];
  const req = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "246810",
    sendSms: async ({ to, body }) => {
      smsBodies.push({ to, body });
      return { ok: true, status: "queued" };
    },
  });
  assert.equal(req.ok, true);
  assert.equal(req.sent, true);
  assert.equal(req.toMasked, "••••0123");
  assert.equal(smsBodies.length, 1);
  assert.match(smsBodies[0].body, /246810/);
  assert.equal(db.rows[0].reset_token_hash, hashSmsResetCode(user.id, "246810"));
  assert.equal(db.rows[0].apple_id, "apple.sub.example");

  const verified = await verifySmsPasswordResetCode(user.email, "246810", { dbQuery: db.dbQuery });
  assert.equal(verified.ok, true);
  assert.match(String(verified.resetToken), /^[a-f0-9]{64}$/);

  const done = await completePasswordResetWithToken(verified.resetToken, STRONG_PASSWORD, { dbQuery: db.dbQuery });
  assert.equal(done.ok, true);
  assert.match(String(db.rows[0].password_hash), /^\$2[aby]?\$/);
  assert.equal(db.rows[0].apple_id, "apple.sub.example");
  assert.equal(db.rows[0].reset_token_hash, null);
  assert.deepEqual(db.assignment, assignment);
});

test("email/password user with verified phone can complete SMS reset", async () => {
  const user = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Local User",
    email: "local-phone@example.com",
    role: "user",
    account_status: "active",
    apple_id: null,
    password_hash: "old-hash",
    phone: "5555550199",
    phone_e164: "+15555550199",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "111222",
    sendSms: async () => ({ ok: true }),
  });
  const verified = await verifySmsPasswordResetCode(user.email, "111222", { dbQuery: db.dbQuery });
  const done = await completePasswordResetWithToken(verified.resetToken, STRONG_PASSWORD, { dbQuery: db.dbQuery });
  assert.equal(done.ok, true);
  assert.notEqual(db.rows[0].password_hash, "old-hash");
});

test("wrong SMS code is rejected", async () => {
  const user = {
    id: "33333333-3333-4333-8333-333333333333",
    email: "wrong-code@example.com",
    role: "user",
    account_status: "active",
    phone_e164: "+15555550111",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "654321",
    sendSms: async () => ({ ok: true }),
  });
  const bad = await verifySmsPasswordResetCode(user.email, "000000", { dbQuery: db.dbQuery });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_code");
});

test("expired SMS code is rejected", async () => {
  const user = {
    id: "44444444-4444-4444-8444-444444444444",
    email: "expired@example.com",
    role: "user",
    account_status: "active",
    phone_e164: "+15555550112",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  const t0 = Date.parse("2026-09-13T12:00:00.000Z");
  await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    now: t0,
    generateCode: () => "777888",
    sendSms: async () => ({ ok: true }),
  });
  const expired = await verifySmsPasswordResetCode(user.email, "777888", {
    dbQuery: db.dbQuery,
    now: t0 + 11 * 60 * 1000,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, "invalid_code");
});

test("SMS code cannot be reused after verify", async () => {
  const user = {
    id: "55555555-5555-4555-8555-555555555555",
    email: "reuse@example.com",
    role: "user",
    account_status: "active",
    phone_e164: "+15555550113",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "121212",
    sendSms: async () => ({ ok: true }),
  });
  const first = await verifySmsPasswordResetCode(user.email, "121212", { dbQuery: db.dbQuery });
  assert.equal(first.ok, true);
  const second = await verifySmsPasswordResetCode(user.email, "121212", { dbQuery: db.dbQuery });
  assert.equal(second.ok, false);
  assert.equal(second.error, "invalid_code");
});

test("excessive verify attempts lock out", async () => {
  const user = {
    id: "66666666-6666-4666-8666-666666666666",
    email: "lockout@example.com",
    role: "user",
    account_status: "active",
    phone_e164: "+15555550114",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "999000",
    sendSms: async () => ({ ok: true }),
  });
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await verifySmsPasswordResetCode(user.email, "000111", { dbQuery: db.dbQuery });
  }
  assert.equal(last.ok, false);
  assert.equal(last.error, "locked");
  const still = await verifySmsPasswordResetCode(user.email, "999000", { dbQuery: db.dbQuery });
  assert.equal(still.error, "locked");
});

test("unknown email returns the same generic success and does not SMS", async () => {
  const db = createMockResetDb([]);
  let sent = 0;
  const result = await requestSmsPasswordReset("nobody@example.com", {
    dbQuery: db.dbQuery,
    sendSms: async () => {
      sent += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.userFound, false);
  assert.equal(result.message, NEUTRAL_SMS_FORGOT_MESSAGE);
  assert.equal(sent, 0);
});

test("disabled account does not receive SMS", async () => {
  const user = {
    id: "77777777-7777-4777-8777-777777777777",
    email: "disabled@example.com",
    role: "user",
    account_status: "disabled",
    phone_e164: "+15555550115",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  let sent = 0;
  const result = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    sendSms: async () => {
      sent += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
});

test("unverified or missing phone does not receive SMS", async () => {
  const user = {
    id: "88888888-8888-4888-8888-888888888888",
    email: "nophone@example.com",
    role: "user",
    account_status: "active",
    phone: null,
    phone_e164: null,
    phone_verified: false,
  };
  const db = createMockResetDb([user]);
  let sent = 0;
  const result = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    sendSms: async () => {
      sent += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
});

test("Super Admin is not reset through this SMS path", async () => {
  const user = {
    id: "99999999-9999-4999-8999-999999999999",
    email: "service@ifcdc.org",
    role: "super_admin",
    account_status: "active",
    phone_e164: "+15555550116",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  let sent = 0;
  const result = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "101010",
    sendSms: async () => {
      sent += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
  const verify = await verifySmsPasswordResetCode(user.email, "101010", { dbQuery: db.dbQuery });
  assert.equal(verify.ok, false);
});

test("request throttle rejects a second SMS request within a minute", async () => {
  const user = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "throttle@example.com",
    role: "user",
    account_status: "active",
    phone_e164: "+15555550117",
    phone_verified: true,
  };
  const db = createMockResetDb([user]);
  const first = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "202020",
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(first.ok, true);
  const second = await requestSmsPasswordReset(user.email, {
    dbQuery: db.dbQuery,
    generateCode: () => "303030",
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, "sms_rate_limited");
});

test("six-digit OTP is not accepted as a reset-password token", async () => {
  const result = await completePasswordResetWithToken("123456", STRONG_PASSWORD, {
    dbQuery: async () => ({ rows: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_token");
});
