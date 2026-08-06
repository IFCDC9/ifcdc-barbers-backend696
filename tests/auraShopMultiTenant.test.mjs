import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("platform shared number is never mixed with founder handset", () => {
  const { PLATFORM_SHARED_E164 } = require("../auraShopContext.cjs");
  const { FOUNDER_VERIFIED_PHONE_E164 } = require("../auraFounderIdentity.cjs");
  assert.equal(PLATFORM_SHARED_E164, "+19895141064");
  assert.notEqual(PLATFORM_SHARED_E164, FOUNDER_VERIFIED_PHONE_E164);
});

test("dedicated To match isolates shop", async () => {
  const { resolveInboundShopContext } = require("../auraShopContext.cjs");
  const shops = [
    {
      id: 10,
      name: "Shop Alpha",
      twilio_phone_e164: "+15551110001",
      public_phone_e164: "+15551110001",
      aura_enabled: true,
      voice_enabled: true,
      aura_telephony_active: true,
      account_status: "active",
      approval_status: "approved",
      timezone: "America/New_York",
    },
    {
      id: 20,
      name: "Shop Beta",
      twilio_phone_e164: "+15552220002",
      public_phone_e164: "+15552220002",
      aura_enabled: true,
      voice_enabled: true,
      aura_telephony_active: true,
      account_status: "active",
      approval_status: "approved",
      timezone: "America/New_York",
    },
  ];
  const dbQuery = async (sql, params = []) => {
    if (/CREATE|ALTER|INSERT INTO aura_shop/i.test(sql)) return { rows: [] };
    if (/FROM businesses/i.test(sql) && params[0] === "+15551110001") {
      return { rows: [shops[0]] };
    }
    if (/FROM businesses/i.test(sql) && params[0] === "+15552220002") {
      return { rows: [shops[1]] };
    }
    return { rows: [] };
  };
  const a = await resolveInboundShopContext(dbQuery, { to: "+15551110001", from: "+15553334444" });
  assert.equal(a.shop?.shopId, 10);
  assert.equal(a.method, "dedicated_twilio_to");
  assert.equal(a.needsShopSelection, false);

  const b = await resolveInboundShopContext(dbQuery, { to: "+15552220002", from: "+15553334444" });
  assert.equal(b.shop?.shopId, 20);
  assert.notEqual(a.shop?.shopId, b.shop?.shopId);
});

test("shared platform number requires shop selection when no history", async () => {
  const { resolveInboundShopContext } = require("../auraShopContext.cjs");
  const dbQuery = async (sql) => {
    if (/CREATE|ALTER|INSERT/i.test(sql)) return { rows: [] };
    if (/FROM bookings/i.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const out = await resolveInboundShopContext(dbQuery, {
    to: "+19895141064",
    from: "+15559998888",
  });
  assert.equal(out.platformShared, true);
  assert.equal(out.needsShopSelection, true);
  assert.equal(out.shop, null);
});

test("unknown called number does not invent a shop", async () => {
  const { resolveInboundShopContext } = require("../auraShopContext.cjs");
  const dbQuery = async (sql) => {
    if (/CREATE|ALTER|INSERT/i.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const out = await resolveInboundShopContext(dbQuery, {
    to: "+15550001111",
    from: "+15559998888",
  });
  assert.equal(out.method, "unknown_called_number");
  assert.equal(out.shop, null);
});

test("assertBarberInShop rejects cross-tenant barber", async () => {
  const { assertBarberInShop } = require("../auraShopContext.cjs");
  const dbQuery = async (sql, params) => {
    if (Number(params[1]) === 10 && String(params[0]) === "barber-a") {
      return { rows: [{ id: "barber-a" }] };
    }
    return { rows: [] };
  };
  assert.equal(await assertBarberInShop(dbQuery, "barber-a", 10), true);
  assert.equal(await assertBarberInShop(dbQuery, "barber-a", 99), false);
});

test("dynamic greetings differ by shop vs shared", () => {
  const { buildShopGreeting, SHOP_SELECT_PROMPT } = require("../auraShopContext.cjs");
  const shopGreet = buildShopGreeting({
    shop: { shopName: "Red Bank Cuts", customGreeting: null },
    needsShopSelection: false,
  });
  assert.match(shopGreet, /Red Bank Cuts/);
  assert.match(shopGreet, /powered by the I F C D C Barbers App/i);

  const shared = buildShopGreeting({ platformShared: true, needsShopSelection: true });
  assert.match(shared, /Which shop or location/i);
  assert.match(SHOP_SELECT_PROMPT, /location or shop/i);

  const founder = buildShopGreeting({ founder: true });
  assert.match(founder, /Mister Allah/);
  assert.match(founder, /platform-wide summary|specific shop/i);
});

test("inactive dedicated shop is flagged", async () => {
  const { resolveInboundShopContext } = require("../auraShopContext.cjs");
  const dbQuery = async (sql, params = []) => {
    if (/CREATE|ALTER|INSERT/i.test(sql)) return { rows: [] };
    if (params[0] === "+15557770000") {
      return {
        rows: [
          {
            id: 7,
            name: "Closed Shop",
            twilio_phone_e164: "+15557770000",
            aura_telephony_active: false,
            aura_enabled: true,
            voice_enabled: true,
            account_status: "active",
            approval_status: "approved",
          },
        ],
      };
    }
    return { rows: [] };
  };
  const out = await resolveInboundShopContext(dbQuery, { to: "+15557770000", from: "+15551112222" });
  assert.equal(out.inactive, true);
  assert.equal(out.shop?.shopId, 7);
});
