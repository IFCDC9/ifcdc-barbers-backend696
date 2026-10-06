/**
 * HQ notification activity is a SELECT. Fixture token only.
 * No production network, no mail, and no SMS.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createBookingsAdminGuard } from "../bookingsAdminGuard.js";
import { createAdminUsersRouter } from "../adminUsersRoutes.js";
import { createBookingsRouter } from "../bookingsRoutes.js";
import { HQ_SNAPSHOT_READ_TOKEN_ENV } from "../hqOperationsSnapshot.js";
import {
  createHqNotificationActivityRouter,
  loadNotificationActivity,
  mapEmailClaim,
  mapSmsLog,
  readOnlySelect,
} from "../hqNotificationActivity.js";

const FIXTURE_TOKEN = randomBytes(32).toString("hex");
const FIXTURE_ADMIN = randomBytes(32).toString("hex");
const BOOKING_ID = "00000000-0000-4000-8000-000000000099";

function listen(app) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

async function call(port, method, path, headers = {}, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

test("stored claim and SMS columns map without inventing missing fields", () => {
  const claim = mapEmailClaim({
    idempotency_key: `booking:${BOOKING_ID}:booking_confirmation`,
    template_id: "booking_confirmation",
    status: "sent",
    provider: "postmark",
    message_id: "pm-fixture-1",
    updated_at: "2026-10-06T12:00:00.000Z",
    fallback_used: false,
  });
  assert.equal(claim.recipient, null);
  assert.equal(claim.createdAt, null);
  assert.equal(claim.retryCount, null);
  assert.equal(claim.errorReason, null);
  assert.equal(claim.fallbackUsed, false);
  assert.equal(claim.providerMessageId, "pm-fixture-1");
  assert.equal(claim.provider, "postmark");
  assert.equal(claim.bookingId, BOOKING_ID);
  assert.equal(claim.status, "accepted");
  assert.equal(claim.storedStatus, "sent");
  assert.notEqual(claim.status, "delivered");

  const sparse = mapEmailClaim({
    idempotency_key: "capture:cap-1:booking_confirmation",
    template_id: "booking_confirmation",
    status: "uncertain",
  });
  assert.equal(sparse.bookingId, null);
  assert.equal(sparse.provider, null);
  assert.equal(sparse.providerMessageId, null);
  assert.equal(sparse.fallbackUsed, null);
  assert.equal(sparse.status, "pending");

  const sms = mapSmsLog({
    to_e164: "+15555550100",
    category: "booking_reminder",
    booking_id: BOOKING_ID,
    twilio_sid: "SM-fixture",
    status: "delivered",
    created_at: "2026-10-06T12:00:00.000Z",
    updated_at: "2026-10-06T12:01:00.000Z",
    error_message: null,
    metadata: { reminderWindow: "24h" },
    fallback_used: true,
    provider: "twilio",
  });
  assert.equal(sms.recipient, "+15555550100");
  assert.equal(sms.provider, "twilio");
  assert.equal(sms.providerMessageId, "SM-fixture");
  assert.equal(sms.fallbackUsed, true);
  assert.equal(sms.reminderWindow, "24h");
  assert.equal(sms.status, "delivered");
  assert.equal(sms.retryCount, null);

  const smsMissing = mapSmsLog({ category: "booking_canceled", status: "failed", error_message: "carrier" });
  assert.equal(smsMissing.provider, null);
  assert.equal(smsMissing.providerMessageId, null);
  assert.equal(smsMissing.recipient, null);
  assert.equal(smsMissing.reminderWindow, null);
  assert.equal(smsMissing.fallbackUsed, null);
  assert.equal(smsMissing.errorReason, "carrier");
  assert.equal(smsMissing.status, "failed");
});

test("activity SQL is a SELECT of stored columns only", () => {
  const source = readFileSync(new URL("../hqNotificationActivity.js", import.meta.url), "utf8");
  assert.equal(/\bINSERT INTO\b|\bUPDATE\s|\bDELETE FROM\b|api\.postmarkapp\.com|api\.twilio\.com/i.test(source), false);
  const emailSql = readOnlySelect("email_delivery_claims", ["idempotency_key", "template_id", "status", "provider", "message_id", "updated_at"]);
  const smsSql = readOnlySelect("sms_message_log", ["twilio_sid", "status", "to_e164", "created_at"]);
  assert.match(emailSql, /^SELECT /);
  assert.match(smsSql, /^SELECT /);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(emailSql + smsSql), false);
  assert.equal(emailSql.includes("recipient"), false);
  assert.equal(smsSql.includes("body_preview"), false);
  assert.equal(readOnlySelect("email_delivery_claims", []), null);
});

test("notification activity rejects a missing token, an admin key, and write methods", async () => {
  process.env[HQ_SNAPSHOT_READ_TOKEN_ENV] = FIXTURE_TOKEN;
  const queries = [];
  const dbQuery = async (sql, params) => {
    queries.push({ sql, params });
    if (String(sql).includes("information_schema")) {
      if (params?.[0] === "email_delivery_claims") {
        return { rows: ["idempotency_key", "template_id", "status", "provider", "message_id", "updated_at", "fallback_used"].map((column_name) => ({ column_name })) };
      }
      return { rows: ["created_at", "updated_at", "twilio_sid", "status", "to_e164", "category", "booking_id", "error_message", "metadata", "fallback_used"].map((column_name) => ({ column_name })) };
    }
    if (String(sql).includes("email_delivery_claims")) {
      return {
        rows: [{
          idempotency_key: `booking:${BOOKING_ID}:booking_reschedule:2026-10-07:10:00 AM`,
          template_id: "booking_reschedule",
          status: "sent",
          provider: "postmark",
          message_id: "pm-fixture-2",
          updated_at: "2026-10-06T13:00:00.000Z",
          fallback_used: false,
        }],
      };
    }
    return {
      rows: [{
        created_at: "2026-10-06T13:00:00.000Z",
        updated_at: "2026-10-06T13:02:00.000Z",
        twilio_sid: "SM-fixture-2",
        status: "delivered",
        to_e164: "+15555550101",
        category: "booking_rescheduled",
        booking_id: BOOKING_ID,
        error_message: null,
        metadata: {},
        fallback_used: null,
      }],
    };
  };

  const app = express();
  app.use("/api/hq", createHqNotificationActivityRouter({ dbQuery }));
  const { server, port } = await listen(app);
  try {
    const missing = await call(port, "GET", "/api/hq/notification-activity");
    const adminKey = await call(port, "GET", "/api/hq/notification-activity", { "x-admin-key": FIXTURE_ADMIN });
    const bearer = await call(port, "GET", "/api/hq/notification-activity", { authorization: `Bearer ${FIXTURE_TOKEN}` });
    const wrong = await call(port, "GET", "/api/hq/notification-activity", { "x-ifcdc-hq-read-token": "not-the-token" });
    const posted = await call(port, "POST", "/api/hq/notification-activity", { "x-ifcdc-hq-read-token": FIXTURE_TOKEN }, {});
    const ok = await call(port, "GET", "/api/hq/notification-activity", { "x-ifcdc-hq-read-token": FIXTURE_TOKEN });

    assert.equal(missing.status, 401);
    assert.equal(adminKey.status, 401);
    assert.equal(bearer.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(posted.status, 405);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.readOnly, true);
    assert.equal(ok.json.email.records[0].provider, "postmark");
    assert.equal(ok.json.email.records[0].providerMessageId, "pm-fixture-2");
    assert.equal(ok.json.email.records[0].fallbackUsed, false);
    assert.equal(ok.json.email.records[0].recipient, null);
    assert.equal(ok.json.email.records[0].retryCount, null);
    assert.equal(ok.json.email.records[0].bookingId, BOOKING_ID);
    assert.equal(ok.json.email.records[0].status, "accepted");
    assert.equal(ok.json.sms.records[0].provider, null);
    assert.equal(ok.json.sms.records[0].providerMessageId, "SM-fixture-2");
    assert.equal(ok.json.sms.records[0].status, "delivered");
    assert.equal(queries.length > 0, true);
    for (const query of queries) {
      assert.match(query.sql, /^SELECT /);
      assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(query.sql), false);
    }
    assert.equal(ok.text.includes(FIXTURE_TOKEN), false);
  } finally {
    server.close();
    delete process.env[HQ_SNAPSHOT_READ_TOKEN_ENV];
  }
});

test("the read token still cannot cancel, reschedule, or admin-write", async () => {
  process.env[HQ_SNAPSHOT_READ_TOKEN_ENV] = FIXTURE_TOKEN;
  process.env.ADMIN_SECRET = FIXTURE_ADMIN;
  const app = express();
  app.use(express.json());
  app.use("/api/hq", createHqNotificationActivityRouter({
    dbQuery: async () => { throw new Error("activity query must not run"); },
  }));
  const adminGuard = createBookingsAdminGuard({
    resolveAuthPayload: () => null,
    dbQuery: async () => { throw new Error("admin query must not run"); },
  });
  app.use(createBookingsRouter({
    sendBookingEmail: async () => { throw new Error("mail must not send"); },
    sendBookingPush: async () => { throw new Error("push must not send"); },
    requireAdmin: adminGuard,
  }));
  app.use(createAdminUsersRouter({
    sendEmail: async () => { throw new Error("mail must not send"); },
  }));
  const header = { "x-ifcdc-hq-read-token": FIXTURE_TOKEN };
  const { server, port } = await listen(app);
  try {
    const cancel = await call(port, "POST", "/api/bookings/00000000-0000-4000-8000-000000000099/cancel", header, { reason: "test" });
    const reschedule = await call(port, "POST", "/api/bookings/00000000-0000-4000-8000-000000000099/reschedule", header, { date: "2026-10-05", time: "10:00 AM" });
    const adminPatch = await call(port, "PATCH", "/api/admin/bookings/00000000-0000-4000-8000-000000000099", header, { action: "cancel" });
    assert.equal(cancel.status, 401);
    assert.equal(reschedule.status, 401);
    assert.equal(adminPatch.status, 401);
  } finally {
    server.close();
    delete process.env[HQ_SNAPSHOT_READ_TOKEN_ENV];
    delete process.env.ADMIN_SECRET;
  }
});

test("server mount stays a read route and does not put the header in server.js", () => {
  const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.equal(serverSource.includes("createHqNotificationActivityRouter"), true);
  assert.equal(serverSource.includes("x-ifcdc-hq-read-token"), false);
  assert.equal(typeof loadNotificationActivity, "function");
});
