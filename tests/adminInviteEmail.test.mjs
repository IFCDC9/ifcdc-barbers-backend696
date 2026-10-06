/**
 * Admin invite delivery. Fixture provider only. Does not create or send an invite.
 */
process.env.NODE_ENV = "test";
process.env.EMAIL_RATE_LIMIT_PER_MIN = "40";
process.env.EMAIL_RATE_LIMIT_GLOBAL_PER_MIN = "200";
process.env.POSTMARK_SERVER_TOKEN = "fixture-postmark-token";
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_RECIPIENT_ALLOWLIST;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createSqlLedger } = require("../emailDelivery.cjs");
const { deliverAdminInviteEmail } = await import("../adminInviteRoutes.js");
const { mapEmailClaim } = await import("../hqNotificationActivity.js");

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async dbQuery(sql, params = []) {
      const text = String(sql);
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("INSERT")) {
        const [key, templateId] = params;
        if (rows.has(key)) return { rows: [] };
        rows.set(key, { template_id: templateId, status: "in_flight", provider: null, message_id: null });
        return { rows: [{ status: "in_flight" }] };
      }
      if (text.includes("SELECT status")) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ status: row.status }] : [] };
      }
      if (text.includes("status = 'failed'")) {
        const row = rows.get(params[0]);
        if (row?.status === "failed") {
          row.status = "in_flight";
          row.template_id = params[1];
          row.provider = null;
          row.message_id = null;
          return { rows: [{ status: "in_flight" }] };
        }
        return { rows: [] };
      }
      if (text.includes("UPDATE")) {
        const [status, provider, messageId, key] = params;
        const row = rows.get(key);
        row.status = status;
        row.provider = provider;
        row.message_id = messageId;
        return { rows: [] };
      }
      throw new Error("unexpected sql");
    },
  };
}

function harness(mode) {
  const db = memoryDb();
  const ledger = createSqlLedger(db.dbQuery);
  const fetches = [];
  const resends = [];
  const key = "invite:inv-1:admin_invite";
  const fetchImpl = async () => {
    fetches.push(mode);
    assert.equal(db.rows.get(key)?.status, "in_flight");
    if (mode === "throw") throw new Error("timeout");
    if (mode === "reject") return { status: 422, json: async () => ({ ErrorCode: 406 }) };
    if (mode === "uncertain") return { status: 503, json: async () => ({}) };
    return { status: 200, json: async () => ({ ErrorCode: 0, MessageID: "pm-fixture" }) };
  };
  const sendResend = async () => {
    resends.push("resend");
    return { success: true, provider: "resend", messageId: "re-fixture" };
  };
  return { db, fetches, resends, deps: { ledger, fetchImpl, sendResend } };
}

const inviteArgs = {
  to: "invite@fixture.test",
  name: "Fixture",
  role: "barber",
  inviteUrl: "https://ifcdcbarbersapp.com/invite/fixture",
  welcomeNote: "Welcome",
  inviteId: "inv-1",
};

test("admin invite claims before Postmark and does not call Resend on success", async () => {
  const box = harness("accept");
  const sent = await deliverAdminInviteEmail({ ...inviteArgs, deps: box.deps });
  assert.equal(sent.success, true);
  assert.equal(sent.delivered, false);
  const row = box.db.rows.get("invite:inv-1:admin_invite");
  assert.equal(row.template_id, "admin_invite");
  assert.equal(row.status, "sent");
  assert.equal(row.provider, "postmark");
  assert.equal(row.message_id, "pm-fixture");
  assert.equal(box.resends.length, 0);
  const again = await deliverAdminInviteEmail({ ...inviteArgs, deps: box.deps });
  assert.equal(again.duplicate, true);
  assert.equal(box.fetches.length, 1);
  const mapped = mapEmailClaim({
    template_id: "admin_invite",
    status: "sent",
    provider: "postmark",
    message_id: "pm-fixture",
    idempotency_key: "invite:inv-1:admin_invite",
  });
  assert.equal(mapped.status, "accepted");
  assert.equal(mapped.relationship, "account_security");
  assert.notEqual(mapped.status, "delivered");
});

test("admin invite falls back once on rejection and stays uncertain on timeout or 5xx", async () => {
  const rejected = harness("reject");
  await deliverAdminInviteEmail({ ...inviteArgs, to: "invite-reject@fixture.test", deps: rejected.deps });
  assert.equal(rejected.resends.length, 1);
  assert.equal(rejected.db.rows.get("invite:inv-1:admin_invite").provider, "resend");

  const thrown = harness("throw");
  await deliverAdminInviteEmail({ ...inviteArgs, to: "invite-throw@fixture.test", deps: thrown.deps });
  assert.equal(thrown.resends.length, 0);
  assert.equal(thrown.db.rows.get("invite:inv-1:admin_invite").status, "uncertain");

  const uncertain = harness("uncertain");
  await deliverAdminInviteEmail({ ...inviteArgs, to: "invite-5xx@fixture.test", deps: uncertain.deps });
  assert.equal(uncertain.resends.length, 0);
  assert.equal(uncertain.db.rows.get("invite:inv-1:admin_invite").status, "uncertain");
});

test("admin invite route no longer calls the Resend sender", () => {
  const src = readFileSync(fileURLToPath(new URL("../adminInviteRoutes.js", import.meta.url)), "utf8");
  assert.equal(src.includes("sendEmailFn"), false);
  assert.equal(src.includes('templateId: "admin_invite"'), true);
  assert.equal(src.includes("invite:${id}:admin_invite"), true);
});
