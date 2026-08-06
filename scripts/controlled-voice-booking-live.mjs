#!/usr/bin/env node
/**
 * Controlled live voice-booking integration tests (production DB).
 * Does not change Twilio / Verify / PayPal / A2P config.
 *
 *   CONFIRM_LIVE_VOICE_BOOKING=1 node --import ./loadBackendEnv.mjs scripts/controlled-voice-booking-live.mjs
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const {
  listBookableBarbers,
  loadServicesForBarber,
  matchService,
  queryAvailability,
  parseSpokenDateToYmd,
  parseSpokenTimeToSlotLabel,
  validateSelectedSlot,
  submitVoiceBooking,
  findFirstAvailableAcrossBarbers,
  shopTimezone,
} = require("../auraVoiceIntelligenceBooking.cjs");
const { insertAuraVoiceBookingRow } = require("../bookingsRoutes.js");
const { dbQuery } = await import("../db.js");

if (process.env.CONFIRM_LIVE_VOICE_BOOKING !== "1") {
  console.error("Set CONFIRM_LIVE_VOICE_BOOKING=1 to run.");
  process.exit(2);
}

const sendEmailNoop = async () => ({ ok: true });
const insertVoiceRow = (body) => insertAuraVoiceBookingRow(body, sendEmailNoop);

function shortConf(id) {
  return String(id || "")
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
}

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(detail));
}

async function main() {
  console.log("=== Controlled voice booking live tests ===");
  console.log("timezone", shopTimezone());

  const tomorrow = await parseSpokenDateToYmd("tomorrow", shopTimezone());
  const friday = await parseSpokenDateToYmd("Friday", shopTimezone());
  record("parse_tomorrow", Boolean(tomorrow), { tomorrow });
  record("parse_friday", Boolean(friday), { friday });

  const t230 = await parseSpokenTimeToSlotLabel("2:30 pm");
  record("parse_230pm", t230 === "02:30 PM", { t230 });

  const barbers = await listBookableBarbers(dbQuery);
  record("list_bookable_barbers", Array.isArray(barbers) && barbers.length > 0, {
    count: barbers?.length || 0,
    sample: (barbers || []).slice(0, 3).map((b) => b.name),
  });
  if (!barbers?.length) {
    console.log(JSON.stringify({ ok: false, results }, null, 2));
    process.exit(1);
  }

  const specific = barbers[0];
  const services = await loadServicesForBarber(dbQuery, {
    barberId: specific.id,
    barberName: specific.name,
  });
  record("load_services", Array.isArray(services) && services.length > 0, {
    count: services?.length || 0,
    sample: (services || []).slice(0, 3).map((s) => ({
      name: s.name || s.title,
      price: s.price,
      duration: s.duration_minutes,
    })),
  });

  const svc30 =
    matchService(services || [], "Regular Haircut") ||
    matchService(services || [], "Haircut") ||
    (services || []).find((s) => Number(s.duration_minutes) === 30) ||
    (services || [])[0];
  const svc60 =
    (services || []).find((s) => Number(s.duration_minutes) >= 60) ||
    (services || []).find((s) => Number(s.duration_minutes) >= 45) ||
    [...(services || [])].sort(
      (a, b) => Number(b.duration_minutes || 0) - Number(a.duration_minutes || 0),
    )[0] ||
    svc30;
  record("service_30", Boolean(svc30), {
    name: svc30?.name || svc30?.title,
    duration: svc30?.duration_minutes,
    price: svc30?.price,
  });
  record("service_60_or_long", Boolean(svc60) && Number(svc60?.duration_minutes) >= 40, {
    name: svc60?.name || svc60?.title,
    duration: svc60?.duration_minutes,
    price: svc60?.price,
  });

  const avail = await queryAvailability(dbQuery, {
    barberId: specific.id,
    barberName: specific.name,
    dateYmd: tomorrow,
    durationMinutes: Number(svc30?.duration_minutes) || 30,
  });
  record("availability_specific_barber_tomorrow", avail.ok === true, {
    openCount: avail.openSlots?.length || 0,
    sample: (avail.openSlots || []).slice(0, 5),
    reasonIfEmpty: avail.reasonIfEmpty || null,
  });

  const first = await findFirstAvailableAcrossBarbers(dbQuery, {
    dateYmd: tomorrow,
    durationMinutes: Number(svc30?.duration_minutes) || 30,
    serviceName: svc30?.name || svc30?.title,
  });
  record("first_available_barber_tomorrow", first.ok === true, {
    barber: first.barberName,
    openCount: first.openSlots?.length || 0,
  });

  // Find a future day with open slots if tomorrow empty
  let bookDay = tomorrow;
  let bookSlots = avail.openSlots || [];
  let bookBarber = specific;
  if (!bookSlots.length && first.ok) {
    bookBarber = { id: first.barberId, name: first.barberName };
    bookSlots = first.openSlots;
  }
  if (!bookSlots.length) {
    for (let add = 2; add <= 10; add++) {
      const [y, m, d] = tomorrow.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + add - 1));
      const ymd = dt.toISOString().slice(0, 10);
      const a = await queryAvailability(dbQuery, {
        barberId: specific.id,
        barberName: specific.name,
        dateYmd: ymd,
        durationMinutes: Number(svc30?.duration_minutes) || 30,
      });
      if (a.ok && a.openSlots?.length) {
        bookDay = ymd;
        bookSlots = a.openSlots;
        break;
      }
    }
  }
  record("found_bookable_day", bookSlots.length > 0, { bookDay, openCount: bookSlots.length });

  // Unavailable time check
  const bad = await validateSelectedSlot({
    barberId: bookBarber.id,
    barberName: bookBarber.name,
    dateYmd: bookDay,
    timeLabel: "03:17 AM",
    durationMinutes: Number(svc30?.duration_minutes) || 30,
  });
  record("unavailable_time_rejected", bad.ok === false, { code: bad.code, message: bad.message });

  if (!bookSlots.length) {
    console.log(JSON.stringify({ ok: false, reason: "no_open_slots", results }, null, 2));
    process.exit(1);
  }

  const slot = bookSlots[0];
  const callSid = `voice_ctrl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const out = await submitVoiceBooking(insertVoiceRow, {
    channel: "aura_voice",
    name: "AURA Voice Controlled Test",
    email: `aura.voice.test.${Date.now()}@ifcdc-voice.placeholder`,
    phone: "+18484694448",
    date: bookDay,
    time: slot,
    barberId: bookBarber.id,
    barber: bookBarber.name,
    service: svc30?.name || svc30?.title || "Haircut",
    price: svc30?.price != null ? Number(svc30.price) : 25,
    callSid,
    durationMinutes: Number(svc30?.duration_minutes) || 30,
  });
  const bookingId = out?.booking?.id || null;
  record("successful_booking", Boolean(out?.ok && bookingId), {
    confirmation: shortConf(bookingId),
    bookingId,
    error: out?.error || null,
    message: out?.message || null,
    day: bookDay,
    time: slot,
    barber: bookBarber.name,
  });

  // Double-book same slot should fail
  const callSid2 = `voice_ctrl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const dup = await submitVoiceBooking(insertVoiceRow, {
    channel: "aura_voice",
    name: "AURA Voice Dup Test",
    email: `aura.voice.dup.${Date.now()}@ifcdc-voice.placeholder`,
    phone: "+18484694448",
    date: bookDay,
    time: slot,
    barberId: bookBarber.id,
    barber: bookBarber.name,
    service: svc30?.name || svc30?.title || "Haircut",
    price: svc30?.price != null ? Number(svc30.price) : 25,
    callSid: callSid2,
  });
  record("double_booking_prevention", dup?.ok !== true, {
    error: dup?.error || null,
    message: dup?.message || null,
  });

  // Failed booking path (bad time)
  const fail = await submitVoiceBooking(insertVoiceRow, {
    channel: "aura_voice",
    name: "AURA Voice Fail Test",
    email: `aura.voice.fail.${Date.now()}@ifcdc-voice.placeholder`,
    phone: "+18484694448",
    date: bookDay,
    time: "03:17 AM",
    barberId: bookBarber.id,
    barber: bookBarber.name,
    service: "Haircut",
    callSid: `voice_ctrl_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  });
  record("failed_booking_bad_slot", fail?.ok !== true, { error: fail?.error || null });

  const passed = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ ok: passed === results.length, passed, total: results.length, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
