/**
 * AURA Voice → production booking/availability bridge.
 * Reuses barberSlotEngine + bookingServicesCatalog + barberIdentity — no duplicate scheduler.
 */
function logVoiceBooking(event, payload = {}) {
  const safe = { ...payload };
  if (safe.email) safe.email = "[redacted]";
  if (safe.phone) safe.phone = String(safe.phone).replace(/\d(?=\d{4})/g, "•");
  console.log(`[aura-voice-booking] ${event}`, JSON.stringify(safe));
}

async function loadSlotEngine() {
  return import("./barberSlotEngine.js");
}

function shopTimezone() {
  return String(process.env.SHOP_TIMEZONE || "America/New_York").trim() || "America/New_York";
}

/**
 * Parse spoken date phrases into YYYY-MM-DD in America/New_York (or barber TZ).
 */
async function parseSpokenDateToYmd(raw, timezone = shopTimezone()) {
  const { resolveBookingDateLabelToYmd, todayYmdInTimezone } = await loadSlotEngine();
  const tz = timezone || shopTimezone();
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;

  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  if (/\btoday\b/.test(text)) return resolveBookingDateLabelToYmd("Today", tz);
  if (/\btomorrow\b/.test(text)) return resolveBookingDateLabelToYmd("Tomorrow", tz);

  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const wantNext = /\bnext\b/.test(text);
  for (const day of days) {
    if (new RegExp(`\\b${day}\\b`).test(text)) {
      let ymd = resolveBookingDateLabelToYmd(day, tz);
      if (!ymd) return null;
      const today = todayYmdInTimezone(tz);
      if (wantNext && ymd === today) {
        const [y, m, d] = ymd.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d + 7));
        ymd = dt.toISOString().slice(0, 10);
      }
      return ymd;
    }
  }

  const md = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );
  if (md) {
    const months = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
      may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
      september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
    };
    const mo = months[md[1].toLowerCase()];
    const day = Number(md[2]);
    if (mo && day >= 1 && day <= 31) {
      const today = todayYmdInTimezone(tz);
      let year = Number(today.slice(0, 4));
      let ymd = `${year}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (ymd < today) {
        year += 1;
        ymd = `${year}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      return ymd;
    }
  }

  return null;
}

/**
 * Parse spoken time → slot label "HH:MM AM/PM" (required by validateBookingSlot).
 * Optional period hint: morning / afternoon / evening.
 */
async function parseSpokenTimeToSlotLabel(raw, { periodHint = null } = {}) {
  const { minutesToSlotLabel } = await loadSlotEngine();
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;

  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const mi = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const ap = /p/i.test(ampm[3]) ? "PM" : "AM";
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return minutesToSlotLabel(h * 60 + mi);
  }

  const t24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) {
    return minutesToSlotLabel(parseInt(t24[1], 10) * 60 + parseInt(t24[2], 10));
  }

  // bare hour with period context
  const hourOnly = text.match(/\b(\d{1,2})\b/);
  const period =
    periodHint ||
    (/\bmorning\b/.test(text)
      ? "morning"
      : /\bafternoon\b/.test(text)
        ? "afternoon"
        : /\bevening\b/.test(text)
          ? "evening"
          : null);
  if (hourOnly && period) {
    let h = parseInt(hourOnly[1], 10);
    if (period === "afternoon" || period === "evening") {
      if (h < 12) h += 12;
    }
    if (period === "morning" && h === 12) h = 0;
    return minutesToSlotLabel(h * 60);
  }

  if (/\bmorning\b/.test(text)) return minutesToSlotLabel(10 * 60);
  if (/\bafternoon\b/.test(text)) return minutesToSlotLabel(14 * 60);
  if (/\bevening\b/.test(text)) return minutesToSlotLabel(17 * 60);

  return null;
}

function extractPeriodHint(raw) {
  const t = String(raw || "").toLowerCase();
  if (/\bmorning\b/.test(t)) return "morning";
  if (/\bafternoon\b/.test(t)) return "afternoon";
  if (/\bevening\b/.test(t)) return "evening";
  return null;
}

async function listBookableBarbers(dbQuery, { limit = 12, shopId = null } = {}) {
  // Fail closed: never list cross-tenant barbers when shop context is missing.
  if (shopId == null || shopId === "" || !Number.isFinite(Number(shopId))) {
    logVoiceBooking("validation_error", {
      step: "list_barbers",
      error: "shop_required",
      message: "shopId required for tenant isolation",
    });
    return [];
  }
  const { isBarberBookable } = require("./barberBookingPolicy.cjs");
  let rows = [];
  try {
    const r = await dbQuery(
      `SELECT id, name
       FROM barbers
       WHERE business_id = $1::bigint
         AND coalesce(booking_hidden, false) = false
       ORDER BY name ASC NULLS LAST
       LIMIT 40`,
      [Number(shopId)],
    );
    rows = r.rows || [];
  } catch (e) {
    logVoiceBooking("database_error", { step: "list_barbers", error: e?.message || String(e), shopId });
    return null;
  }
  const out = [];
  for (const row of rows) {
    const key = row.id ?? row.name;
    try {
      const ok = await isBarberBookable(dbQuery, key, { channel: "mobile" });
      if (ok) out.push({ id: row.id, name: String(row.name || "").trim() });
    } catch {
      /* skip */
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function resolveBarber(dbQuery, { barberId, barberName, firstAvailable = false, shopId = null } = {}) {
  const { resolveBarberIdentity, scheduleBarberIdFromResolved } = require("./barberIdentity.cjs");
  const { isBarberBookable } = require("./barberBookingPolicy.cjs");
  const { assertBarberInShop } = require("./auraShopContext.cjs");

  if (firstAvailable || /\bfirst available|any barber|anyone|no preference\b/i.test(String(barberName || ""))) {
    const list = await listBookableBarbers(dbQuery, { shopId });
    if (list === null) return { ok: false, error: "database_error" };
    if (!list.length) return { ok: false, error: "no_barbers" };
    const pick = list[0];
    const resolved = await resolveBarberIdentity(dbQuery, { id: pick.id, name: pick.name });
    const scheduleId = scheduleBarberIdFromResolved(resolved) ?? pick.id;
    if (shopId != null && !(await assertBarberInShop(dbQuery, scheduleId, shopId))) {
      return { ok: false, error: "barber_wrong_shop" };
    }
    const bookable = await isBarberBookable(dbQuery, scheduleId, { channel: "mobile" });
    if (!bookable) return { ok: false, error: "barber_not_bookable" };
    return {
      ok: true,
      barberId: scheduleId,
      barberName: pick.name || resolved?.name || "Barber",
      firstAvailable: true,
    };
  }

  try {
    const resolved = await resolveBarberIdentity(dbQuery, {
      id: barberId || undefined,
      name: barberName || undefined,
    });
    if (!resolved) return { ok: false, error: "barber_not_found" };
    const scheduleId = scheduleBarberIdFromResolved(resolved) ?? resolved.id;
    if (shopId != null && !(await assertBarberInShop(dbQuery, scheduleId, shopId))) {
      return { ok: false, error: "barber_wrong_shop" };
    }
    const bookable = await isBarberBookable(dbQuery, scheduleId, { channel: "mobile" });
    if (!bookable) return { ok: false, error: "barber_not_bookable" };
    return {
      ok: true,
      barberId: scheduleId,
      barberName: String(resolved.name || barberName || "").trim() || "Barber",
      firstAvailable: false,
    };
  } catch (e) {
    logVoiceBooking("database_error", { step: "resolve_barber", error: e?.message || String(e) });
    return { ok: false, error: "database_error", message: e?.message || String(e) };
  }
}

async function loadServicesForBarber(dbQuery, { barberId, barberName }) {
  const { fetchPublicBarberServices } = require("./bookingServicesCatalog.cjs");
  try {
    const out = await fetchPublicBarberServices(dbQuery, {
      barberIdRaw: barberId,
      barberName,
    });
    const services = Array.isArray(out) ? out : Array.isArray(out?.services) ? out.services : [];
    return services;
  } catch (e) {
    logVoiceBooking("database_error", { step: "load_services", error: e?.message || String(e) });
    return null;
  }
}

function matchService(services, spoken) {
  const t = String(spoken || "").trim().toLowerCase();
  if (!t || !Array.isArray(services) || !services.length) return null;
  const exact = services.find((s) => String(s.name || s.title || "").trim().toLowerCase() === t);
  if (exact) return exact;
  const fuzzy = services.find((s) => {
    const n = String(s.name || s.title || "").toLowerCase();
    return n.includes(t) || t.includes(n) || (/\bfade\b/.test(t) && /\bfade\b/.test(n)) || (/\bbeard\b/.test(t) && /\bbeard\b/.test(n)) || (/\bhaircut|cut\b/.test(t) && /\bhaircut|cut\b/.test(n));
  });
  return fuzzy || null;
}

async function queryAvailability(dbQuery, { barberId, barberName, dateYmd, durationMinutes = 30 }) {
  const engine = await loadSlotEngine();
  logVoiceBooking("availability_query_request", {
    barberId,
    barberName,
    dateYmd,
    durationMinutes,
    timezone: shopTimezone(),
  });
  try {
    try {
      const { expireStalePendingPaymentBookings } = require("./bookingCleanup.cjs");
      await expireStalePendingPaymentBookings(dbQuery);
    } catch {
      /* optional */
    }
    const payload = await engine.getAvailableSlotsForBarberDate(barberId, dateYmd, barberName, {
      durationMinutes: Math.max(1, Number(durationMinutes) || 30),
    });
    const open = (payload.slots || []).filter((s) => s.available).map((s) => s.time);
    logVoiceBooking("availability_query_response", {
      barberId,
      dateYmd,
      openCount: open.length,
      reasonIfEmpty: payload.reasonIfEmpty || null,
      timezone: payload.timezone,
      sample: open.slice(0, 5),
    });
    return {
      ok: true,
      timezone: payload.timezone || shopTimezone(),
      openSlots: open,
      allSlots: payload.slots || [],
      reasonIfEmpty: payload.reasonIfEmpty || null,
      durationMinutes: payload.durationMinutes || durationMinutes,
    };
  } catch (e) {
    logVoiceBooking("database_error", { step: "availability", error: e?.message || String(e) });
    return { ok: false, error: "database_error", message: e?.message || String(e) };
  }
}

async function findFirstAvailableAcrossBarbers(dbQuery, { dateYmd, durationMinutes = 30, serviceName = null, shopId = null }) {
  const barbers = await listBookableBarbers(dbQuery, { shopId });
  if (!barbers?.length) return { ok: false, error: "no_barbers" };
  for (const b of barbers) {
    let duration = durationMinutes;
    if (serviceName) {
      const services = await loadServicesForBarber(dbQuery, { barberId: b.id, barberName: b.name });
      const match = matchService(services || [], serviceName);
      if (match) duration = Number(match.duration_minutes) || duration;
    }
    const avail = await queryAvailability(dbQuery, {
      barberId: b.id,
      barberName: b.name,
      dateYmd,
      durationMinutes: duration,
    });
    if (avail.ok && avail.openSlots?.length) {
      return {
        ok: true,
        barberId: b.id,
        barberName: b.name,
        dateYmd,
        openSlots: avail.openSlots,
        timezone: avail.timezone,
        durationMinutes: duration,
      };
    }
  }
  return { ok: false, error: "no_open_slots", dateYmd };
}

async function validateSelectedSlot({ barberId, barberName, dateYmd, timeLabel, durationMinutes }) {
  const engine = await loadSlotEngine();
  logVoiceBooking("selected_appointment_slot", {
    barberId,
    barberName,
    dateYmd,
    timeLabel,
    durationMinutes,
  });
  const check = await engine.validateBookingSlot(barberId, dateYmd, timeLabel, barberName, {
    durationMinutes: Math.max(1, Number(durationMinutes) || 30),
  });
  if (!check.ok) {
    logVoiceBooking("validation_error", {
      code: check.code,
      message: check.message,
      barberId,
      dateYmd,
      timeLabel,
    });
  }
  return check;
}

/**
 * Submit via existing production voice insert (same path as Twilio voice).
 */
async function submitVoiceBooking(insertVoiceRow, body) {
  logVoiceBooking("booking_submission", {
    barberId: body.barberId,
    barber: body.barber,
    date: body.date,
    time: body.time,
    service: body.service,
    callSid: body.callSid ? String(body.callSid).slice(0, 12) : null,
  });
  try {
    const out = await insertVoiceRow(body);
    logVoiceBooking("booking_response", {
      ok: Boolean(out?.ok),
      error: out?.error || null,
      message: out?.message || null,
      bookingId: out?.booking?.id || null,
      deduped: Boolean(out?.deduped),
    });
    if (!out?.ok) {
      logVoiceBooking("validation_error", { error: out?.error, message: out?.message });
    } else if (out.booking?.id) {
      logVoiceBooking("final_confirmation_number", {
        confirmation: String(out.booking.id).replace(/-/g, "").slice(0, 8).toUpperCase(),
        bookingId: out.booking.id,
      });
    }
    return out;
  } catch (e) {
    logVoiceBooking("database_error", { step: "booking_insert", error: e?.message || String(e) });
    return { ok: false, error: "database_error", message: e?.message || String(e) };
  }
}

function speakSlotList(slots, { max = 4 } = {}) {
  const list = (slots || []).slice(0, max);
  if (!list.length) return "I don't have any open times on that day.";
  if (list.length === 1) return `I have ${list[0]} available.`;
  const head = list.slice(0, -1).join(", ");
  return `I have ${head}, or ${list[list.length - 1]}.`;
}

function failFinalizeReply() {
  return "I'm unable to finalize that appointment right now. I have not charged you or confirmed the booking.";
}

module.exports = {
  logVoiceBooking,
  shopTimezone,
  parseSpokenDateToYmd,
  parseSpokenTimeToSlotLabel,
  extractPeriodHint,
  listBookableBarbers,
  resolveBarber,
  loadServicesForBarber,
  matchService,
  queryAvailability,
  findFirstAvailableAcrossBarbers,
  validateSelectedSlot,
  submitVoiceBooking,
  speakSlotList,
  failFinalizeReply,
};
