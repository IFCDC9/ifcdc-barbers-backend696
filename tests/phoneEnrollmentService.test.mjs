import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  requestPhoneEnrollment,
  verifyPhoneEnrollment,
  resetPhoneEnrollmentLimits,
  hashEnrollmentCode,
  CANONICAL_SUPER_ADMIN_SMS_E164,
} from "../phoneEnrollmentService.js";
import {
  requestSmsPasswordReset,
  resolveVerifiedResetPhone,
  hashSmsResetCode,
  resetSmsPasswordResetLimits,
} from "../passwordResetService.js";

const APPLE_ID = "001234.apple.sub";
const APPLE_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function seedAppleUser(overrides = {}) {
  return {
    id: APPLE_USER_ID,
    name: "Apple Customer",
    email: "apple-enroll@example.com",
    role: "user",
    account_status: "active",
    apple_id: APPLE_ID,
    phone: null,
    phone_e164: null,
    phone_verified: false,
    phone_verified_at: null,
    phone_enroll_otp_hash: null,
    phone_enroll_otp_expires_at: null,
    phone_enroll_phone_e164: null,
    profile_image_url: null,
    barber_id: null,
    business_id: null,
    preferred_language: "en",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockDb(seedUsers, assignmentSnapshot) {
  const rows = seedUsers.map((u) => ({ ...u }));
  const assignment = assignmentSnapshot ? { ...assignmentSnapshot } : null;
  const calls = [];
  async function dbQuery(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ");
    calls.push({ q, params });
    if (/apple_id\s*=/.test(q) && /UPDATE app_users/.test(q)) {
      throw new Error("must not update apple_id");
    }
    if (/linked_email\s*=/.test(q) || /role\s*=/.test(q)) {
      throw new Error("must not update role or linked_email");
    }
    if (/management_assignments|manager_shop_access|manager_location_access/.test(q)) {
      throw new Error("must not touch management tables");
    }
    if (/ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE/.test(q)) {
      return { rows: [] };
    }
    if (q.includes("FROM app_users") && q.includes("WHERE id =") && q.includes("phone_enroll_otp_hash")) {
      return { rows: rows.filter((u) => u.id === params[0]).slice(0, 1) };
    }
    if (q.includes("FROM app_users") && q.includes("phone_verified IS TRUE") && q.includes("phone_e164 =")) {
      const e164 = params[0];
      const exclude = params[1];
      return {
        rows: rows
          .filter((u) => u.phone_verified === true && u.phone_e164 === e164 && u.id !== exclude)
          .slice(0, 1)
          .map((u) => ({ id: u.id })),
      };
    }
    if (q.includes("FROM app_users") && q.includes("lower(trim(email")) {
      const em = String(params[0] || "").toLowerCase();
      return { rows: rows.filter((u) => String(u.email).toLowerCase() === em).slice(0, 1) };
    }
    if (q.includes("SET phone_enroll_otp_hash = NULL")) {
      const u = rows.find((x) => x.id === params[0]);
      if (u) {
        u.phone_enroll_otp_hash = null;
        u.phone_enroll_otp_expires_at = null;
        u.phone_enroll_phone_e164 = null;
      }
      return { rows: [] };
    }
    if (q.includes("SET phone_enroll_otp_hash =")) {
      const [hash, exp, e164, id] = params;
      const u = rows.find((x) => x.id === id);
      if (u) {
        u.phone_enroll_otp_hash = hash;
        u.phone_enroll_otp_expires_at = exp;
        u.phone_enroll_phone_e164 = e164;
      }
      return { rows: [] };
    }
    if (q.includes("SET phone =") && q.includes("phone_verified = true")) {
      const [id, phone, e164] = params;
      const u = rows.find((x) => x.id === id);
      if (u) {
        u.phone = phone;
        u.phone_e164 = e164;
        u.phone_verified = true;
        u.phone_verified_at = new Date().toISOString();
        u.phone_enroll_otp_hash = null;
        u.phone_enroll_otp_expires_at = null;
        u.phone_enroll_phone_e164 = null;
      }
      return { rows: u ? [{ ...u }] : [] };
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
  resetPhoneEnrollmentLimits();
  resetSmsPasswordResetLimits();
});

test("Apple user can enroll a verified phone without changing apple_id or session identity", async () => {
  const assignment = {
    role: "shop_manager",
    status: "active",
    linked_email: "apple-enroll@example.com",
    user_id: APPLE_USER_ID,
  };
  const db = createMockDb([seedAppleUser()], assignment);
  let sms = [];
  const req = await requestPhoneEnrollment(APPLE_USER_ID, "5555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "135790",
    sendSms: async ({ to, body }) => {
      sms.push({ to, body });
      return { ok: true, status: "queued" };
    },
  });
  assert.equal(req.ok, true);
  assert.equal(req.sent, true);
  assert.equal(req.toMasked, "••••0123");
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, "+15555550123");
  assert.match(sms[0].body, /135790/);
  assert.equal(db.rows[0].phone_verified, false);
  assert.equal(db.rows[0].apple_id, APPLE_ID);
  assert.equal(db.rows[0].phone_enroll_otp_hash, hashEnrollmentCode(APPLE_USER_ID, "135790"));

  const verified = await verifyPhoneEnrollment(APPLE_USER_ID, "135790", { dbQuery: db.dbQuery });
  assert.equal(verified.ok, true);
  assert.equal(verified.phoneVerified, true);
  assert.equal(db.rows[0].phone_verified, true);
  assert.equal(db.rows[0].phone_e164, "+15555550123");
  assert.equal(db.rows[0].apple_id, APPLE_ID);
  assert.equal(db.rows[0].id, APPLE_USER_ID);
  assert.equal(db.rows[0].role, "user");
  assert.equal(db.rows[0].phone_enroll_otp_hash, null);
  assert.deepEqual(db.assignment, assignment);
  assert.equal(verified.user.id, APPLE_USER_ID);
  assert.equal(verified.user.phoneVerified, true);
});

test("wrong OTP is rejected and does not verify", async () => {
  const db = createMockDb([seedAppleUser()]);
  await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "111111",
    sendSms: async () => ({ ok: true }),
  });
  const bad = await verifyPhoneEnrollment(APPLE_USER_ID, "000000", { dbQuery: db.dbQuery });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_code");
  assert.equal(db.rows[0].phone_verified, false);
});

test("expired OTP is rejected", async () => {
  const t0 = Date.parse("2026-09-13T12:00:00.000Z");
  const db = createMockDb([seedAppleUser()]);
  await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "222222",
    sendSms: async () => ({ ok: true }),
    now: () => t0,
  });
  const late = await verifyPhoneEnrollment(APPLE_USER_ID, "222222", {
    dbQuery: db.dbQuery,
    now: () => t0 + 11 * 60 * 1000,
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, "expired");
  assert.equal(db.rows[0].phone_verified, false);
});

test("reused OTP is rejected after success", async () => {
  const db = createMockDb([seedAppleUser()]);
  await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "333333",
    sendSms: async () => ({ ok: true }),
  });
  const first = await verifyPhoneEnrollment(APPLE_USER_ID, "333333", { dbQuery: db.dbQuery });
  assert.equal(first.ok, true);
  const again = await verifyPhoneEnrollment(APPLE_USER_ID, "333333", { dbQuery: db.dbQuery });
  assert.equal(again.ok, false);
  assert.equal(again.error, "reused");
});

test("excessive request-verification is rate limited", async () => {
  const db = createMockDb([seedAppleUser()]);
  const t0 = Date.parse("2026-09-13T15:00:00.000Z");
  const sendSms = async () => ({ ok: true });
  for (let i = 0; i < 5; i += 1) {
    const r = await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
      dbQuery: db.dbQuery,
      generateCode: () => "444444",
      sendSms,
      now: () => t0 + i * 61_000,
    });
    assert.equal(r.ok, true, `request ${i} should succeed`);
  }
  const blocked = await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "444444",
    sendSms,
    now: () => t0 + 5 * 61_000,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "rate_limited");
});

test("malformed number is rejected and no SMS is sent", async () => {
  const db = createMockDb([seedAppleUser()]);
  let sent = 0;
  const r = await requestPhoneEnrollment(APPLE_USER_ID, "12", {
    dbQuery: db.dbQuery,
    sendSms: async () => {
      sent += 1;
      return { ok: true };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "phone_invalid");
  assert.equal(sent, 0);
  assert.equal(db.rows[0].phone_verified, false);
});

test("duplicate verified phone cannot attach to a second account", async () => {
  const owner = seedAppleUser({
    id: OTHER_USER_ID,
    email: "owner@example.com",
    apple_id: "other.apple",
    phone_e164: "+15555550999",
    phone_verified: true,
  });
  const db = createMockDb([seedAppleUser(), owner]);
  const r = await requestPhoneEnrollment(APPLE_USER_ID, "+15555550999", {
    dbQuery: db.dbQuery,
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "duplicate_phone");
  assert.equal(db.rows[0].phone_verified, false);
  assert.equal(db.rows[0].apple_id, APPLE_ID);
});

test("manager assignment snapshot is untouched by enrollment", async () => {
  const assignment = {
    role: "shop_manager",
    status: "active",
    linked_email: "apple-enroll@example.com",
    user_id: APPLE_USER_ID,
  };
  const db = createMockDb([seedAppleUser()], assignment);
  await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "555555",
    sendSms: async () => ({ ok: true }),
  });
  await verifyPhoneEnrollment(APPLE_USER_ID, "555555", { dbQuery: db.dbQuery });
  assert.deepEqual(db.assignment, assignment);
  assert.equal(
    db.calls.some((c) => /management_assignments/.test(c.q)),
    false,
  );
});

test("Super Admin identity and reserved SMS number stay protected", async () => {
  const sa = seedAppleUser({
    id: SA_USER_ID,
    email: "service@ifcdc.org",
    role: "super_admin",
    apple_id: null,
  });
  const otherDb = createMockDb([seedAppleUser(), sa]);
  const reserved = await requestPhoneEnrollment(APPLE_USER_ID, CANONICAL_SUPER_ADMIN_SMS_E164, {
    dbQuery: otherDb.dbQuery,
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(reserved.ok, false);
  assert.equal(reserved.error, "phone_reserved");
  assert.equal(otherDb.rows[0].role, "user");
  assert.equal(otherDb.rows[1].role, "super_admin");
  assert.equal(otherDb.rows[1].email, "service@ifcdc.org");

  const saDb = createMockDb([sa]);
  const ok = await requestPhoneEnrollment(SA_USER_ID, "+15555550777", {
    dbQuery: saDb.dbQuery,
    generateCode: () => "666666",
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(ok.ok, true);
  const verified = await verifyPhoneEnrollment(SA_USER_ID, "666666", { dbQuery: saDb.dbQuery });
  assert.equal(verified.ok, true);
  assert.equal(saDb.rows[0].role, "super_admin");
  assert.equal(saDb.rows[0].email, "service@ifcdc.org");
});

test("forgot-password SMS reads the same verified columns after enrollment", async () => {
  const db = createMockDb([seedAppleUser()]);
  await requestPhoneEnrollment(APPLE_USER_ID, "+15555550123", {
    dbQuery: db.dbQuery,
    generateCode: () => "777777",
    sendSms: async () => ({ ok: true }),
  });
  await verifyPhoneEnrollment(APPLE_USER_ID, "777777", { dbQuery: db.dbQuery });
  const phone = resolveVerifiedResetPhone(db.rows[0]);
  assert.equal(phone.ok, true);
  assert.equal(phone.e164, "+15555550123");

  const reset = await requestSmsPasswordReset("apple-enroll@example.com", {
    dbQuery: db.dbQuery,
    generateCode: () => "888888",
    sendSms: async () => ({ ok: true }),
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.sent, true);
  assert.equal(db.rows[0].reset_token_hash, hashSmsResetCode(APPLE_USER_ID, "888888"));
  assert.equal(db.rows[0].apple_id, APPLE_ID);
});
