import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("listBookableBarbers fails closed without shopId", async () => {
  const { listBookableBarbers } = require("../auraVoiceIntelligenceBooking.cjs");
  const called = [];
  const dbQuery = async (sql) => {
    called.push(sql);
    return { rows: [{ id: 1, name: "ShouldNotAppear" }] };
  };
  const out = await listBookableBarbers(dbQuery, {});
  assert.deepEqual(out, []);
  assert.equal(called.length, 0);
});

test("listBookableBarbers scopes SQL by business_id", async () => {
  const { listBookableBarbers } = require("../auraVoiceIntelligenceBooking.cjs");
  let paramsSeen = null;
  const dbQuery = async (sql, params) => {
    if (/FROM barbers/i.test(sql)) {
      paramsSeen = params;
      assert.match(sql, /business_id\s*=\s*\$1::bigint/i);
      return { rows: [] };
    }
    return { rows: [] };
  };
  // isBarberBookable may still be called 0 times when empty
  const out = await listBookableBarbers(dbQuery, { shopId: 1 });
  assert.deepEqual(out, []);
  assert.deepEqual(paramsSeen, [1]);
});

test("Shop A barber assert rejects Shop B", async () => {
  const { assertBarberInShop } = require("../auraShopContext.cjs");
  const dbQuery = async (_sql, params) => {
    if (Number(params[1]) === 1 && String(params[0]) === "barber-a") {
      return { rows: [{ id: "barber-a" }] };
    }
    return { rows: [] };
  };
  assert.equal(await assertBarberInShop(dbQuery, "barber-a", 1), true);
  assert.equal(await assertBarberInShop(dbQuery, "barber-a", 2), false);
  assert.equal(await assertBarberInShop(dbQuery, "barber-a", null), false);
});

test("unknown caller cannot start shop information update", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_upd_deny_${Date.now()}`;
  getSession(sid).greeted = true;
  getSession(sid).shopId = 1;
  getSession(sid).shopName = "IFCDC Barbers";
  const out = await runVoiceIntelligenceTurn({
    dbQuery: async () => ({ rows: [] }),
    callSid: sid,
    from: "+15551234567",
    userInput: "Update the shop telephone number",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /cannot change shop information|Only the verified Founder/i);
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("founder shop update requires PIN before save", async () => {
  process.env.AURA_VOICE_INTELLIGENCE_PHASE_1 = "1";
  process.env.AURA_OWNER_VOICE_PHONE = "+18484694448";
  process.env.AURA_OWNER_VOICE_PIN = "1357";
  const { runVoiceIntelligenceTurn, getSession } = require("../auraVoiceIntelligenceOrchestrator.cjs");
  const sid = `CA_upd_pin_${Date.now()}`;
  const sess = getSession(sid);
  sess.greeted = true;
  sess.shopId = 1;
  sess.shopName = "IFCDC Barbers";
  sess.ownerPinOk = false;
  const dbQuery = async (sql) => {
    if (/FROM businesses/i.test(sql) && /operating_hours/i.test(sql)) {
      return {
        rows: [
          {
            operating_hours_json: null,
            holiday_hours_json: null,
            temporary_closed: false,
            address: "123 Main",
            city: "Detroit",
            state: "MI",
          },
        ],
      };
    }
    if (/FROM businesses/i.test(sql)) {
      return {
        rows: [
          {
            id: 1,
            name: "IFCDC Barbers",
            phone: "+19895141064",
            public_phone_e164: "+19895141064",
            aura_enabled: true,
            voice_enabled: true,
            aura_telephony_active: true,
            account_status: "active",
            approval_status: "approved",
          },
        ],
      };
    }
    return { rows: [] };
  };
  const out = await runVoiceIntelligenceTurn({
    dbQuery,
    callSid: sid,
    from: "+18484694448",
    to: "+19895141064",
    userInput: "Update the business hours",
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /PIN/i);
  assert.equal(sess.infoUpdate?.field, "operatingHours");
  assert.equal(sess.infoUpdate?.step, "await_pin");
  delete process.env.AURA_OWNER_VOICE_PIN;
  delete process.env.AURA_VOICE_INTELLIGENCE_PHASE_1;
});

test("detect shop update intents", () => {
  const { detectShopUpdateIntent } = require("../auraFounderShopUpdates.cjs");
  assert.equal(detectShopUpdateIntent("Change the shop telephone number").field, "publicPhoneNumber");
  assert.equal(detectShopUpdateIntent("Update the business hours").field, "operatingHours");
  assert.equal(detectShopUpdateIntent("Set the greeting").field, "customGreeting");
  assert.equal(detectShopUpdateIntent("hello there"), null);
});
