/**
 * Dedicated IFCDC HQ read snapshot.
 * The read token is accepted only on GET /api/hq/operations-snapshot
 * and GET /api/hq/notification-activity.
 * It is not an admin key and must not be wired into write or admin middleware.
 */
import express from "express";
import { timingSafeEqual } from "node:crypto";

export const HQ_SNAPSHOT_READ_HEADER = "x-ifcdc-hq-read-token";
export const HQ_SNAPSHOT_READ_TOKEN_ENV = "BARBERS_HQ_SNAPSHOT_READ_TOKEN";

const CANCELLED = new Set(["cancelled", "canceled", "cancelled_by_customer", "canceled_by_customer"]);
const EXCEPTION_STATUSES = new Set(["no_show", "failed", "payment_failed", "error"]);
const BUSINESS_TZ = "America/New_York";
const PRIVATE_KEY = /phone|email|paypal|card|cvv|ssn|password|secret|token|customer|payment|refund/i;

export function businessToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function hqSnapshotTokensMatch(presented, expected) {
  const left = Buffer.from(String(presented ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function requireHqSnapshotRead(req, res, next) {
  const expected = String(process.env[HQ_SNAPSHOT_READ_TOKEN_ENV] || "").trim();
  if (!expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const presented = String(req.get(HQ_SNAPSHOT_READ_HEADER) || "").trim();
  if (!hqSnapshotTokensMatch(presented, expected)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

function text(value) {
  if (value == null) return "";
  return String(value).trim();
}

function notConnected(reason) {
  return {
    status: "not_connected",
    count: null,
    emptyBecause: null,
    unavailableReason: reason,
    items: [],
  };
}

function answered(count, items, emptyBecause = null) {
  return {
    status: "ok",
    count,
    emptyBecause: count === 0 ? emptyBecause || "source_returned_zero" : null,
    unavailableReason: null,
    items,
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) continue;
    out[key] = redact(child);
  }
  return out;
}

function bookingView(row) {
  const status = text(row.booking_status ?? row.bookingStatus ?? row.status).toLowerCase();
  return {
    date: text(row.date).slice(0, 10) || null,
    time: text(row.time) || null,
    barberName: text(row.barber_name ?? row.barberName) || null,
    service: text(row.service) || null,
    bookingStatus: status || null,
    shopName: text(row.shop_name ?? row.shopName) || null,
  };
}

function isCancelled(status) {
  return Boolean(status && (CANCELLED.has(status) || status.startsWith("cancel")));
}

function isRescheduled(row, status) {
  if (status && status.includes("reschedul")) return true;
  return text(row.rescheduled_at ?? row.rescheduledAt).length > 0;
}

export function buildHqOperationsSnapshot(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const today = businessToday(now);
  const bookingsReadable = input.bookings !== null && input.bookings !== undefined;
  const shopsReadable = input.shops !== null && input.shops !== undefined;
  const openingsReadable = input.openings !== null && input.openings !== undefined;

  let todayBookings = notConnected("Booking rows were not read.");
  let upcomingBookings = notConnected("Booking rows were not read.");
  let reschedules = notConnected("Reschedule history was not read.");
  let cancellations = notConnected("Cancellations were not read.");
  let exceptions = notConnected("Operational exceptions were not read.");
  let shopStatus = notConnected("Shop status was not read.");
  let openings = notConnected("Barber availability was not read.");

  if (bookingsReadable) {
    const rows = Array.isArray(input.bookings) ? input.bookings : [];
    const views = rows.filter((row) => row && typeof row === "object").map((row) => ({ raw: row, view: bookingView(row) }));
    const cancelled = views.filter((row) => isCancelled(row.view.bookingStatus));
    const rescheduled = views.filter((row) => isRescheduled(row.raw, row.view.bookingStatus));
    const active = views.filter((row) => !isCancelled(row.view.bookingStatus) && !isRescheduled(row.raw, row.view.bookingStatus));
    todayBookings = answered(active.filter((row) => row.view.date === today).length, active.filter((row) => row.view.date === today).map((row) => row.view));
    upcomingBookings = answered(active.filter((row) => row.view.date && row.view.date > today).length, active.filter((row) => row.view.date && row.view.date > today).map((row) => row.view));
    cancellations = answered(cancelled.length, cancelled.map((row) => row.view));
    reschedules = answered(rescheduled.length, rescheduled.map((row) => row.view));
    const exceptionItems = views
      .filter((row) => row.view.bookingStatus && EXCEPTION_STATUSES.has(row.view.bookingStatus))
      .map((row) => ({
        kind: row.view.bookingStatus,
        date: row.view.date,
        time: row.view.time,
        barberName: row.view.barberName,
        service: row.view.service,
      }));
    exceptions = answered(exceptionItems.length, exceptionItems);
  }

  if (shopsReadable) {
    const shops = (Array.isArray(input.shops) ? input.shops : [])
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        name: text(row.name ?? row.shopName) || null,
        status: text(row.status ?? row.subscription_status) || null,
      }))
      .filter((row) => row.name || row.status);
    shopStatus = answered(shops.length, shops);
  }

  if (openingsReadable) {
    const days = (Array.isArray(input.openings) ? input.openings : []).filter((day) => day && day.usedFallback !== true);
    const available = days.reduce((sum, day) => sum + Number(day.available || 0), 0);
    const closedOnly = available === 0 && days.length > 0 && days.every((day) => day.reasonIfEmpty === "closed_day");
    openings = answered(
      available,
      days.map((day) => ({
        date: text(day.date) || null,
        barberName: text(day.barberName) || null,
        available: Number(day.available || 0),
        reason: text(day.reasonIfEmpty) || null,
      })),
      closedOnly ? "closed_day" : "source_returned_zero",
    );
  }

  const anyRead = bookingsReadable || shopsReadable || openingsReadable;
  return redact({
    todayBookings,
    upcomingBookings,
    openings,
    shopStatus,
    reschedules,
    cancellations,
    exceptions,
    refreshedAt: anyRead ? now.toISOString() : null,
    sourceHealth: bookingsReadable ? "ok" : "unavailable",
  });
}

function addDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function loadHqOperationsSnapshotFromDb(dbQuery, now = new Date()) {
  let bookings = null;
  let shops = null;
  let openings = null;

  try {
    const result = await dbQuery(
      `SELECT b.date::text AS date,
              to_char(b.time, 'HH12:MI AM') AS time,
              b.barber_name,
              b.service,
              b.booking_status,
              b.rescheduled_at,
              biz.name AS shop_name
       FROM bookings b
       LEFT JOIN businesses biz ON biz.id = b.business_id
       WHERE b.deleted_at IS NULL
       ORDER BY b.date ASC NULLS LAST
       LIMIT 500`,
    );
    bookings = result?.rows || [];
  } catch {
    bookings = null;
  }

  try {
    const result = await dbQuery(
      `SELECT name,
              COALESCE(NULLIF(btrim(subscription_status), ''), 'unknown') AS status
       FROM businesses
       ORDER BY name ASC NULLS LAST
       LIMIT 100`,
    );
    shops = result?.rows || [];
  } catch {
    shops = null;
  }

  try {
    const barbers = await dbQuery(
      `SELECT id::text AS id, name
       FROM barbers
       WHERE name IS NOT NULL AND btrim(name) <> ''
       ORDER BY id ASC
       LIMIT 6`,
    );
    const { getAvailableSlotsForBarberDate } = await import("./barberSlotEngine.js");
    const today = businessToday(now);
    const days = [];
    for (const barber of barbers?.rows || []) {
      for (let offset = 0; offset < 7; offset += 1) {
        const date = addDays(today, offset);
        try {
          const slots = await getAvailableSlotsForBarberDate(barber.id, date, barber.name);
          if (slots?.usedFallback) continue;
          const list = Array.isArray(slots?.slots) ? slots.slots : [];
          days.push({
            date,
            barberName: barber.name,
            available: list.filter((slot) => slot.available === true).length,
            reasonIfEmpty: slots?.reasonIfEmpty || null,
            usedFallback: false,
          });
        } catch {
          /* one barber-day is skipped; other days can still be read */
        }
      }
    }
    openings = days;
  } catch {
    openings = null;
  }

  return buildHqOperationsSnapshot({ now, bookings, shops, openings });
}

export function createHqOperationsSnapshotRouter(options = {}) {
  const requireRead = options.requireRead || requireHqSnapshotRead;
  const loadSnapshot = options.loadSnapshot || ((now) => loadHqOperationsSnapshotFromDb(options.dbQuery, now));
  const router = express.Router();

  router.use("/operations-snapshot", (req, res, next) => {
    if (req.method === "GET") return next();
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  });

  router.get("/operations-snapshot", requireRead, async (_req, res) => {
    try {
      const snapshot = await loadSnapshot(new Date());
      res.json(redact(snapshot));
    } catch {
      res.json(buildHqOperationsSnapshot({ bookings: null, shops: null, openings: null }));
    }
  });

  return router;
}
