import { dbQuery } from "./db.js";
import { buildClientUnavailability } from "./barberUnavailabilityReasons.js";

const DEFAULT_INTERVAL = 30;
const DEFAULT_TIMEZONE = process.env.SHOP_TIMEZONE || "America/New_York";
export const PENDING_HOLD_MINUTES = Number(process.env.BOOKING_PENDING_HOLD_MINUTES || 30);

/**
 * SQL fragment — rows that actively occupy barber schedule slots.
 * Completed / cancelled / no-show / soft-deleted bookings never block.
 * Past paid appointments auto-release when service duration has elapsed.
 *
 * @param {string} [holdMinutesParam] e.g. "$4" — caller's interval bind for pending PayPal holds
 */
export function slotBlockingWhereSql(holdMinutesParam = `'${PENDING_HOLD_MINUTES}'`) {
  return `(
    deleted_at IS NULL
    AND lower(coalesce(booking_status, '')) NOT IN ('cancelled', 'completed', 'no_show')
    AND (
      (
        lower(booking_status) IN ('confirmed', 'checked_in', 'in_progress')
        AND is_paid_booking = true
        AND lower(coalesce(payment_status, '')) IN ('paid', 'paid_full', 'deposit_paid')
        AND (
          (date::timestamp + time)
          + (COALESCE(NULLIF(service_duration_minutes, 0), 30) * interval '1 minute')
        ) > NOW()
      )
      OR (
        lower(booking_status) IN ('pending', 'pending_payment')
        AND paypal_order_id IS NOT NULL
        AND coalesce(is_paid_booking, false) = false
        AND lower(coalesce(payment_status, '')) NOT IN ('paid', 'paid_full', 'deposit_paid')
        AND created_at > NOW() - (${holdMinutesParam}::text || ' minutes')::interval
        AND (date::timestamp + time) >= NOW() - interval '5 minutes'
      )
    )
  )`;
}

const WEEKDAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** @param {string} t HH:MM or HH:MM:SS */
export function parseTimeToMinutes(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59 || hh > 23) return null;
  return hh * 60 + mm;
}

/** Match Postgres `to_char(time, 'HH12:MI AM')`. */
export function minutesToSlotLabel(minutes) {
  const total = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const ap = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${ap}`;
}

export function slotLabelToSqlTime(label) {
  const s = String(label || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

/** Calendar day-of-week (0=Sun) for YYYY-MM-DD in a given IANA timezone. */
export function dayOfWeekForDate(dateStr, timezone = DEFAULT_TIMEZONE) {
  const [y, mo, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !mo || !d) return null;
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" })
    .format(noonUtc)
    .toLowerCase();
  return WEEKDAY_MAP[weekday] ?? null;
}

function normalizeSlotLabel(label) {
  return String(label || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * @param {number|string} barberId
 * @param {string} [barberName]
 */
export async function loadBarberSchedule(barberId, barberName = "") {
  const { coerceBarberIdForTable, logDbInsertDebug, assertNotUuidForBigintBarberId, getTableBarberIdType } =
    await import("./barberIdentity.cjs");
  const bid = await coerceBarberIdForTable(dbQuery, "barber_settings", barberId, barberName);
  if (bid == null || String(bid).trim() === "" || String(bid) === "NaN") {
    throw new Error("invalid_barber_id");
  }
  const settingsCol = await getTableBarberIdType(dbQuery, "barber_settings");
  logDbInsertDebug({
    route: "loadBarberSchedule",
    table: "barber_settings",
    barber_id: bid,
    settingsColType: settingsCol,
  });
  if (settingsCol !== "uuid") {
    assertNotUuidForBigintBarberId(bid, "barber_settings", "loadBarberSchedule");
  }
  await dbQuery(`INSERT INTO barber_settings (barber_id) VALUES ($1) ON CONFLICT (barber_id) DO NOTHING`, [bid]);

  const settings = await dbQuery(
    `SELECT COALESCE(appointment_interval_minutes, 30) AS interval_minutes,
            COALESCE(NULLIF(trim(timezone), ''), $2) AS timezone
     FROM barber_settings WHERE barber_id = $1 LIMIT 1`,
    [bid, DEFAULT_TIMEZONE],
  );
  const intervalMinutes = Math.max(5, Math.min(120, Number(settings.rows?.[0]?.interval_minutes) || DEFAULT_INTERVAL));
  const timezone = String(settings.rows?.[0]?.timezone || DEFAULT_TIMEZONE);

  const avail = await dbQuery(
    `SELECT day_of_week, start_time, end_time, is_off
     FROM barber_availability WHERE barber_id = $1 ORDER BY day_of_week, start_time`,
    [bid],
  );
  const breaks = await dbQuery(
    `SELECT day_of_week, start_time, end_time
     FROM barber_availability_breaks WHERE barber_id = $1 ORDER BY day_of_week, start_time`,
    [bid],
  );
  const blocked = await dbQuery(
    `SELECT to_char(blocked_date, 'YYYY-MM-DD') AS blocked_date,
            client_reason,
            to_char(return_date, 'YYYY-MM-DD') AS return_date,
            client_message
     FROM barber_blocked_dates WHERE barber_id = $1 ORDER BY blocked_date`,
    [bid],
  );

  const blockedDateMeta = {};
  const blockedDates = (blocked.rows || []).map((r) => {
    const d = String(r.blocked_date);
    blockedDateMeta[d] = {
      client_reason: r.client_reason || null,
      return_date: r.return_date || null,
      client_message: r.client_message || null,
    };
    return d;
  });

  return {
    intervalMinutes,
    timezone,
    availability: avail.rows || [],
    breaks: breaks.rows || [],
    blockedDates,
    blockedDateMeta,
  };
}

function isInBreak(minutes, breaks, dow) {
  for (const row of breaks) {
    if (Number(row.day_of_week) !== dow) continue;
    const start = parseTimeToMinutes(row.start_time);
    const end = parseTimeToMinutes(row.end_time);
    if (start == null || end == null) continue;
    if (minutes >= start && minutes < end) return true;
  }
  return false;
}

function generateWindowSlots(startMin, endMin, intervalMinutes) {
  const slots = [];
  const effectiveEnd = endMin <= startMin ? endMin + 24 * 60 : endMin;
  for (let m = startMin; m + intervalMinutes <= effectiveEnd; m += intervalMinutes) {
    slots.push(m >= 24 * 60 ? m - 24 * 60 : m);
  }
  return slots;
}

/** Demo/testing schedule — 9:00 AM through 12:30 AM, all days. */
export function demoFallbackSchedule() {
  return {
    intervalMinutes: DEFAULT_INTERVAL,
    timezone: DEFAULT_TIMEZONE,
    availability: [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      day_of_week,
      start_time: "09:00:00",
      end_time: "01:00:00",
      is_off: false,
    })),
    breaks: [],
    blockedDates: [],
    blockedDateMeta: {},
  };
}

/**
 * Expand weekly schedule into discrete slot start minutes for a calendar date.
 * @returns {number[]}
 */
export function buildScheduleSlotMinutes(schedule, dateStr) {
  const { intervalMinutes, timezone, availability, breaks, blockedDates } = schedule;
  if (blockedDates.includes(dateStr)) return [];

  const dow = dayOfWeekForDate(dateStr, timezone);
  if (dow == null) return [];

  const windows = (availability || []).filter((row) => Number(row.day_of_week) === dow && !row.is_off);
  if (!windows.length) return [];

  const minuteSet = new Set();
  for (const row of windows) {
    const start = parseTimeToMinutes(row.start_time);
    const end = parseTimeToMinutes(row.end_time);
    if (start == null || end == null) continue;
    if (end <= start && end === 0) continue;
    for (const m of generateWindowSlots(start, end, intervalMinutes)) {
      if (!isInBreak(m, breaks, dow)) minuteSet.add(m);
    }
  }
  return sortSlotMinutes(Array.from(minuteSet));
}

/** Keep 12:00 AM slots after evening times when schedule crosses midnight. */
function sortSlotMinutes(minutes) {
  return [...minutes].sort((a, b) => {
    const aKey = a < 9 * 60 ? a + 24 * 60 : a;
    const bKey = b < 9 * 60 ? b + 24 * 60 : b;
    return aKey - bKey;
  });
}

function intervalsOverlap(aStart, aDuration, bStart, bDuration) {
  if (aStart == null || bStart == null) return false;
  const aDur = Math.max(1, Number(aDuration) || 30);
  const bDur = Math.max(1, Number(bDuration) || 30);
  return aStart < bStart + bDur && aStart + aDur > bStart;
}

/** Slot start times blocked by an appointment of given duration. */
export function blockedSlotStartsForBooking(startMinutes, durationMinutes, intervalMinutes) {
  const start = Number(startMinutes);
  const duration = Math.max(1, Number(durationMinutes) || 30);
  const interval = Math.max(5, Number(intervalMinutes) || DEFAULT_INTERVAL);
  if (!Number.isFinite(start)) return [];
  const blocked = [];
  for (let m = start; m < start + duration; m += interval) {
    blocked.push(m);
  }
  return blocked;
}

/**
 * Load confirmed/pending bookings for a barber on a date (with duration).
 * @returns {Promise<{ startMinutes: number, durationMinutes: number, timeLabel: string }[]>}
 */
export async function loadBookingsForDate(barberId, dateStr, barberName = "", options = {}) {
  const { excludeBookingId = null } = options || {};
  const { coerceBarberIdForTable } = await import("./barberIdentity.cjs");
  const name = String(barberName || "").trim();
  const bookingBid = await coerceBarberIdForTable(dbQuery, "bookings", barberId, barberName);
  const exclude = excludeBookingId ? String(excludeBookingId) : null;
  const holdParam = "$4";
  const blockingSql = slotBlockingWhereSql(holdParam);

  const r =
    bookingBid != null
      ? await dbQuery(
          `SELECT to_char(time, 'HH12:MI AM') AS slot,
                  time AS time_raw,
                  COALESCE(NULLIF(service_duration_minutes, 0), 30) AS duration_minutes
           FROM bookings
           WHERE date = $2::date
             AND ($5::text IS NULL OR id::text <> $5::text)
             AND (
               barber_id = $1
               OR ($3 <> '' AND lower(trim(barber_name)) = lower(trim($3)))
             )
             AND ${blockingSql}
           ORDER BY time`,
          [bookingBid, dateStr, name, String(PENDING_HOLD_MINUTES), exclude],
        )
      : await dbQuery(
          `SELECT to_char(time, 'HH12:MI AM') AS slot,
                  time AS time_raw,
                  COALESCE(NULLIF(service_duration_minutes, 0), 30) AS duration_minutes
           FROM bookings
           WHERE date = $1::date
             AND ($4::text IS NULL OR id::text <> $4::text)
             AND $2 <> ''
             AND lower(trim(barber_name)) = lower(trim($2))
             AND ${slotBlockingWhereSql("$3")}
           ORDER BY time`,
          [dateStr, name, String(PENDING_HOLD_MINUTES), exclude],
        );

  return (r.rows || [])
    .map((row) => {
      const startMinutes = parseTimeToMinutes(row.time_raw);
      if (startMinutes == null) return null;
      return {
        startMinutes,
        durationMinutes: Math.max(1, Number(row.duration_minutes) || 30),
        timeLabel: String(row.slot || "").trim(),
      };
    })
    .filter(Boolean);
}

/**
 * @param {number} barberId
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} [barberName]
 * @returns {Promise<{ timezone: string, intervalMinutes: number, slots: { time: string, available: boolean, reason?: string }[] }>}
 */
export async function getAvailableSlotsForBarberDate(
  barberId,
  dateStr,
  barberName = "",
  options = {},
) {
  const { excludeBookingId = null, durationMinutes = 30 } = options || {};
  const requestedDuration = Math.max(1, Number(durationMinutes) || 30);
  const schedule = await loadBarberSchedule(barberId, barberName);
  let minuteStarts = buildScheduleSlotMinutes(schedule, dateStr);
  let reasonIfEmpty = null;
  let unavailability = null;
  let usedFallback = false;

  const hasConfiguredHours = (schedule.availability || []).some((row) => !row.is_off);

  if (!minuteStarts.length) {
    if (schedule.blockedDates.includes(dateStr)) {
      reasonIfEmpty = "blocked_date";
      unavailability = buildClientUnavailability(schedule.blockedDateMeta?.[dateStr]);
    } else if (!hasConfiguredHours) {
      reasonIfEmpty = "no_schedule";
      const fallbackSchedule = {
        ...demoFallbackSchedule(),
        blockedDates: schedule.blockedDates,
        blockedDateMeta: schedule.blockedDateMeta,
      };
      minuteStarts = buildScheduleSlotMinutes(fallbackSchedule, dateStr);
      usedFallback = minuteStarts.length > 0;
      if (!minuteStarts.length) {
        reasonIfEmpty = "blocked_date";
        unavailability = buildClientUnavailability(schedule.blockedDateMeta?.[dateStr]);
      }
    } else {
      reasonIfEmpty = "closed_day";
    }
  }

  const existingBookings = await loadBookingsForDate(barberId, dateStr, barberName, {
    excludeBookingId,
  });
  const interval = schedule.intervalMinutes;

  const slots = minuteStarts.map((m) => {
    const time = minutesToSlotLabel(m);

    for (const booking of existingBookings) {
      if (intervalsOverlap(m, requestedDuration, booking.startMinutes, booking.durationMinutes)) {
        const isExactStart =
          normalizeSlotLabel(time) === normalizeSlotLabel(booking.timeLabel);
        return {
          time,
          available: false,
          reason: isExactStart ? "booked" : "unavailable",
        };
      }
    }

    return { time, available: true };
  });

  console.log(
    "[slots]",
    barberId,
    dateStr,
    `duration=${requestedDuration}`,
    slots.filter((s) => s.available).length,
    "/",
    slots.length,
    reasonIfEmpty || (usedFallback ? "demo_fallback" : "ok"),
  );

  return {
    timezone: schedule.timezone,
    intervalMinutes: schedule.intervalMinutes,
    slots,
    usedFallback,
    reasonIfEmpty,
    unavailability,
    durationMinutes: requestedDuration,
  };
}

/**
 * Paid active appointments + short-lived unpaid PayPal holds block slots (duration-aware).
 * Completed, cancelled, no-show, deleted, and past appointments do not block.
 */
export async function loadOccupiedSlotLabels(barberId, dateStr, barberName = "", options = {}) {
  const { excludeBookingId = null } = options || {};
  const schedule = await loadBarberSchedule(barberId, barberName);
  const bookings = await loadBookingsForDate(barberId, dateStr, barberName, { excludeBookingId });
  const interval = schedule.intervalMinutes;
  const labelSet = new Set();

  for (const booking of bookings) {
    for (const m of blockedSlotStartsForBooking(
      booking.startMinutes,
      booking.durationMinutes,
      interval,
    )) {
      labelSet.add(minutesToSlotLabel(m));
    }
  }

  return [...labelSet];
}

/**
 * @returns {Promise<{ ok: boolean, message?: string, code?: string }>}
 */
export async function validateBookingSlot(
  barberId,
  dateStr,
  timeLabel,
  barberName = "",
  options = {},
) {
  const { excludeBookingId = null, durationMinutes = 30 } = options || {};
  const requestedDuration = Math.max(1, Number(durationMinutes) || 30);
  if (barberId == null || String(barberId).trim() === "" || String(barberId) === "NaN") {
    return { ok: false, code: "invalid_barber", message: "Invalid barber" };
  }

  const timeSql = slotLabelToSqlTime(timeLabel);
  if (!timeSql) return { ok: false, code: "bad_time", message: "Invalid time format" };

  const schedule = await loadBarberSchedule(barberId, barberName);
  if (schedule.blockedDates.includes(dateStr)) {
    const { message } = buildClientUnavailability(schedule.blockedDateMeta?.[dateStr]);
    return { ok: false, code: "blocked_date", message };
  }

  let allowedMinutes = buildScheduleSlotMinutes(schedule, dateStr);
  if (!allowedMinutes.length && !(schedule.availability || []).some((row) => !row.is_off)) {
    const fallbackSchedule = {
      ...demoFallbackSchedule(),
      blockedDates: schedule.blockedDates,
      blockedDateMeta: schedule.blockedDateMeta,
    };
    allowedMinutes = buildScheduleSlotMinutes(fallbackSchedule, dateStr);
  }
  const bookingMin = parseTimeToMinutes(timeSql);
  if (bookingMin == null) return { ok: false, code: "bad_time", message: "Invalid time" };

  if (!allowedMinutes.length) {
    return { ok: false, code: "closed", message: "No availability on this date — pick another day." };
  }

  if (!allowedMinutes.includes(bookingMin)) {
    return { ok: false, code: "outside_hours", message: "That time is not available for this barber." };
  }

  const existingBookings = await loadBookingsForDate(barberId, dateStr, barberName, {
    excludeBookingId,
  });

  for (const booking of existingBookings) {
    if (intervalsOverlap(bookingMin, requestedDuration, booking.startMinutes, booking.durationMinutes)) {
      return {
        ok: false,
        code: "slot_taken",
        message: "That time was just booked — pick another slot.",
      };
    }
  }

  return { ok: true, timeSql, durationMinutes: requestedDuration };
}
