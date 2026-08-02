import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = ["AURA_PHASE2_ENABLED", "AURA_PHASE2_TOOLS_ENABLED"];
const saved = {};

beforeEach(() => {
  for (const k of FLAG_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of FLAG_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("deny-list blocks refunds, prices, deletes, credentials", () => {
  const { denySensitive, DENIED_ACTIONS } = require("../auraPhase2Tools.cjs");
  assert.ok(DENIED_ACTIONS.has("refund"));
  for (const action of [
    "refund",
    "alter_price",
    "delete_record",
    "change_admin_permissions",
    "modify_payment_credentials",
  ]) {
    const out = denySensitive(action);
    assert.equal(out.ok, false);
    assert.equal(out.denied, true);
    assert.equal(out.escalate, true);
    assert.match(out.message, /Super Admin/i);
  }
});

test("tools stay disabled when master off", async () => {
  const { findCustomerBooking, confirmCancel } = require("../auraPhase2Tools.cjs");
  const fakeDb = async () => ({ rows: [] });
  const find = await findCustomerBooking(fakeDb, { bookingId: "00000000-0000-0000-0000-000000000001" });
  assert.equal(find.ok, false);
  assert.equal(find.error, "aura_phase2_tools_disabled");
  const cancel = await confirmCancel(fakeDb, {
    bookingId: "00000000-0000-0000-0000-000000000001",
    confirm: true,
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.error, "aura_phase2_tools_disabled");
});

test("identity gate rejects mismatched email/ref", async () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  process.env.AURA_PHASE2_TOOLS_ENABLED = "1";
  const { assertBookingIdentity } = require("../auraPhase2Tools.cjs");
  const booking = {
    id: "11111111-1111-1111-1111-111111111111",
    customer_email: "owner@example.com",
    user_id: "22222222-2222-2222-2222-222222222222",
  };
  const bad = await assertBookingIdentity(async () => ({}), booking, {
    customerEmail: "other@example.com",
    confirmBookingId: booking.id,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "identity_unverified");

  const goodEmail = await assertBookingIdentity(async () => ({}), booking, {
    customerEmail: "owner@example.com",
    confirmBookingId: booking.id,
  });
  assert.equal(goodEmail.ok, true);
  assert.equal(goodEmail.method, "email_and_reference");

  const goodUser = await assertBookingIdentity(async () => ({}), booking, {
    userId: booking.user_id,
  });
  assert.equal(goodUser.ok, true);
  assert.equal(goodUser.method, "user_id");
});

test("dispatchAuraTool escalates unknown sensitive names", async () => {
  process.env.AURA_PHASE2_ENABLED = "1";
  process.env.AURA_PHASE2_TOOLS_ENABLED = "1";
  const { dispatchAuraTool } = require("../auraPhase2Tools.cjs");
  const out = await dispatchAuraTool(async () => ({ rows: [] }), "issue_refund", {});
  assert.equal(out.denied, true);
});
