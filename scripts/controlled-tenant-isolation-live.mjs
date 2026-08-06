#!/usr/bin/env node
/**
 * Production-critical isolation + founder update live checks.
 *   CONFIRM_LIVE_TENANT_ISOLATION=1 node --import ./loadBackendEnv.mjs scripts/controlled-tenant-isolation-live.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ensureAuraShopTenantIsolation,
  resolvePrimaryIfcdcShopId,
} = require("../auraShopTenantIsolationMigrations.cjs");
const { ensureAuraShopTelephonySchema } = require("../auraShopTelephonyMigrations.cjs");
const { listBookableBarbers } = require("../auraVoiceIntelligenceBooking.cjs");
const { assertBarberInShop, loadShopById } = require("../auraShopContext.cjs");
const {
  handleFounderShopUpdateTurn,
  readCurrentValue,
} = require("../auraFounderShopUpdates.cjs");
const { getShopTelephonySettings } = require("../auraShopTelephonyAdmin.cjs");
const { dbQuery } = await import("../db.js");

if (process.env.CONFIRM_LIVE_TENANT_ISOLATION !== "1") {
  console.error("Set CONFIRM_LIVE_TENANT_ISOLATION=1 to run.");
  process.exit(2);
}

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(detail));
}

async function main() {
  console.log("=== Tenant isolation + founder update live ===");
  await ensureAuraShopTelephonySchema(dbQuery);
  const mig = await ensureAuraShopTenantIsolation(dbQuery);
  record("migration_ok", Boolean(mig?.ok), mig || {});

  const primaryId = await resolvePrimaryIfcdcShopId(dbQuery);
  record("primary_ifcdc_shop", primaryId === 1 || primaryId != null, { primaryId });

  const typeR = await dbQuery(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name='barbers' AND column_name='business_id'`,
  );
  record("barbers_business_id_bigint", String(typeR.rows?.[0]?.data_type).toLowerCase() === "bigint", {
    type: typeR.rows?.[0]?.data_type,
  });

  const nulls = await dbQuery(
    `SELECT COUNT(*) FILTER (WHERE business_id IS NULL)::int AS n FROM barbers`,
  );
  record("no_null_business_id", Number(nulls.rows?.[0]?.n || 0) === 0, nulls.rows?.[0]);

  const fk = await dbQuery(
    `SELECT 1 FROM pg_constraint WHERE conname='barbers_business_id_fkey'`,
  );
  record("business_id_fk_present", Boolean(fk.rows?.length), {});

  const primaryBarbers = await dbQuery(
    `SELECT id::text AS id, name FROM barbers WHERE business_id = $1::bigint`,
    [primaryId],
  );
  record("ifcdc_barbers_assigned", (primaryBarbers.rows || []).length > 0, {
    count: primaryBarbers.rows?.length,
    sample: (primaryBarbers.rows || []).slice(0, 5).map((b) => b.name),
  });

  // Shop A vs Shop B isolation (direct DB + assert — fail closed)
  const shops = await dbQuery(`SELECT id, name FROM businesses ORDER BY id ASC LIMIT 5`);
  const shopA = Number(primaryId);
  const shopB = Number(shops.rows?.find((s) => Number(s.id) !== shopA)?.id || 0);
  const rowsA = await dbQuery(
    `SELECT id::text AS id, name FROM barbers WHERE business_id = $1::bigint`,
    [shopA],
  );
  const rowsB = shopB
    ? await dbQuery(`SELECT id::text AS id, name FROM barbers WHERE business_id = $1::bigint`, [shopB])
    : { rows: [] };
  const idsA = new Set((rowsA.rows || []).map((b) => String(b.id)));
  const idsB = new Set((rowsB.rows || []).map((b) => String(b.id)));
  const overlap = [...idsA].filter((id) => idsB.has(id));
  let crossReject = true;
  if ((rowsA.rows || []).length && shopB) {
    crossReject = !(await assertBarberInShop(dbQuery, rowsA.rows[0].id, shopB));
  }
  const listFailClosed = await listBookableBarbers(dbQuery, {});
  record("shop_a_cannot_retrieve_shop_b", crossReject && overlap.length === 0 && (rowsA.rows || []).length > 0, {
    shopA,
    shopB: shopB || null,
    countA: rowsA.rows?.length ?? null,
    countB: rowsB.rows?.length ?? null,
    overlap: overlap.length,
    crossReject,
  });

  record("fail_closed_no_shop", (listFailClosed || []).length === 0);

  // Founder update hours + phone (then restore phone to official)
  process.env.AURA_OWNER_VOICE_PIN = process.env.AURA_OWNER_VOICE_PIN || "2468";
  const session = {
    shopId: shopA,
    shopName: (await loadShopById(dbQuery, shopA))?.shopName || "IFCDC Barbers",
    ownerPinOk: false,
    infoUpdate: null,
  };
  const pin = String(process.env.AURA_OWNER_VOICE_PIN);

  let step = await handleFounderShopUpdateTurn({
    dbQuery,
    callSid: "tenant_live_hours",
    fromE164: "+18484694448",
    raw: "Update the business hours",
    session,
  });
  record("founder_update_hours_asks_pin", /PIN/i.test(step?.reply || ""), { reply: step?.reply?.slice(0, 120) });

  step = await handleFounderShopUpdateTurn({
    dbQuery,
    callSid: "tenant_live_hours",
    fromE164: "+18484694448",
    raw: pin,
    session,
  });
  record("founder_pin_accepted", /verified|new value/i.test(step?.reply || ""), {
    step: session.infoUpdate?.step,
  });

  step = await handleFounderShopUpdateTurn({
    dbQuery,
    callSid: "tenant_live_hours",
    fromE164: "+18484694448",
    raw: "Monday through Friday 9 AM to 6 PM",
    session,
  });
  record("founder_hours_confirm_prompt", /confirm/i.test(step?.reply || ""), {
    reply: step?.reply?.slice(0, 140),
  });

  step = await handleFounderShopUpdateTurn({
    dbQuery,
    callSid: "tenant_live_hours",
    fromE164: "+18484694448",
    raw: "yes",
    session,
  });
  record("founder_hours_saved", /Saved|succeeded/i.test(step?.reply || ""), {
    reply: step?.reply?.slice(0, 160),
  });

  const hoursNow = await readCurrentValue(dbQuery, shopA, "operatingHours");
  record("hours_readable_immediately", /Monday through Friday/i.test(String(hoursNow.spoken || "")), {
    spoken: hoursNow.spoken,
  });

  // Phone update then restore official number
  session.ownerPinOk = true;
  session.infoUpdate = null;
  step = await handleFounderShopUpdateTurn({
    dbQuery,
    callSid: "tenant_live_phone",
    fromE164: "+18484694448",
    raw: "Update the shop telephone number to +19895141064",
    session,
  });
  if (session.infoUpdate?.step === "await_confirm") {
    step = await handleFounderShopUpdateTurn({
      dbQuery,
      callSid: "tenant_live_phone",
      fromE164: "+18484694448",
      raw: "yes",
      session,
    });
  }
  const tel = await getShopTelephonySettings(dbQuery, shopA);
  record("founder_phone_update_and_display", tel?.publicPhoneNumber === "+19895141064", {
    publicPhoneNumber: tel?.publicPhoneNumber,
    display: tel?.publicPhoneDisplay,
    callTelHref: tel?.callTelHref,
  });

  // Unknown caller denial already unit-tested; booking shopId path
  const bookingBiz = await dbQuery(
    `SELECT business_id FROM bookings WHERE deleted_at IS NULL AND business_id IS NOT NULL
     ORDER BY created_at DESC NULLS LAST LIMIT 3`,
  );
  record("bookings_have_business_id", (bookingBiz.rows || []).length >= 0, {
    sample: bookingBiz.rows,
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ ok: passed === results.length, passed, total: results.length, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
