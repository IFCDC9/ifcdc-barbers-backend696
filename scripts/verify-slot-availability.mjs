#!/usr/bin/env node
/**
 * Verify slot-blocking rules and live availability API shape.
 * Run: node scripts/verify-slot-availability.mjs [--base=URL]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { slotBlockingWhereSql } = require("../barberSlotEngine.js");

const base = (
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ||
  process.env.API_BASE ||
  "https://ifcdc-barbers-backend696.onrender.com"
).replace(/\/$/, "");

let failed = 0;
function ok(msg) {
  console.log("OK:", msg);
}
function fail(msg) {
  console.error("FAIL:", msg);
  failed += 1;
}

const sql = slotBlockingWhereSql("$4");
if (!sql.includes("NOT IN ('cancelled', 'completed', 'no_show')")) {
  fail("blocking SQL must exclude cancelled, completed, and no_show");
} else {
  ok("terminal statuses excluded from slot blocking");
}

if (!sql.includes("checked_in") || !sql.includes("in_progress")) fail("active in-service statuses should block");
else ok("in-service statuses block while active");

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { res, json };
}

console.log(`\nProbing ${base}\n`);

const barbers = await get("/api/app-bookings/barbers");
const barber = (Array.isArray(barbers.json) ? barbers.json : barbers.json?.barbers || [])[0];
if (!barber?.name) {
  fail("no bookable barber for slot probe");
} else {
  const enc = encodeURIComponent(barber.name);
  const slots = await get(
    `/api/app-bookings/available-slots?barberName=${enc}&dateLabel=Today&durationMinutes=30`,
  );
  if (!slots.res.ok) fail(`available-slots HTTP ${slots.res.status}`);
  else {
    ok(`available-slots HTTP ${slots.res.status}`);
    const list = Array.isArray(slots.json.slots) ? slots.json.slots : [];
    const booked = list.filter((s) => s && s.available === false && s.reason === "booked");
    ok(`${list.length} slots returned (${booked.length} marked booked)`);
    const cache = String(slots.res.headers.get("cache-control") || "");
    if (cache.includes("no-store")) ok("Cache-Control: no-store");
    else fail(`expected Cache-Control no-store, got "${cache}"`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll slot availability checks passed");
process.exit(failed ? 1 : 0);
