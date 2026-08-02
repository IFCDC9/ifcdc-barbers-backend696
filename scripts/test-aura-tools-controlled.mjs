#!/usr/bin/env node
/**
 * Controlled AURA Phase 2 tools verification — run one action at a time.
 *
 * Usage:
 *   node --import ./loadBackendEnv.mjs scripts/test-aura-tools-controlled.mjs find
 *   node --import ./loadBackendEnv.mjs scripts/test-aura-tools-controlled.mjs create
 *   node --import ./loadBackendEnv.mjs scripts/test-aura-tools-controlled.mjs reschedule
 *   node --import ./loadBackendEnv.mjs scripts/test-aura-tools-controlled.mjs cancel
 *   node --import ./loadBackendEnv.mjs scripts/test-aura-tools-controlled.mjs status
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const API = "https://ifcdc-barbers-backend696.onrender.com";
const STATE_PATH = "/tmp/aura-tools-controlled-state.json";
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
)
  .trim()
  .toLowerCase();
const CUSTOMER_NAME = "AURA Phase 2 Tools Controlled Test";
const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const SERVICE = "Controlled AURA tools verification";
const OTHER_EMAIL = "other-customer-aura-tools-test@example.com";

process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_TOOLS_ENABLED = "true";
process.env.AURA_PHASE2_RESCHEDULE_EMAIL = "true";
process.env.AURA_DAILY_REPORT_PREVIEW = "false";
process.env.AURA_DAILY_REPORT_ENABLED = "false";

const {
  findCustomerBooking,
  confirmBook,
  confirmReschedule,
  confirmCancel,
  assertBookingIdentity,
} = require("../auraPhase2Tools.cjs");
const { auraPhase2Flags } = require("../auraPhase2Flags.cjs");
const { validateBookingSlot, getAvailableSlotsForBarberDate } = await import(
  "../barberSlotEngine.js"
);

const action = String(process.argv[2] || "status").trim().toLowerCase();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function liveFlags() {
  const res = await fetch(`${API}/api/aura/phase2/status`);
  return res.json();
}

async function liveDeploy() {
  const res = await fetch(`${API}/api/deploy-info`);
  return res.json();
}

async function pickFutureSlot(preferExcludeYmdTime = null) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  for (let day = 0; day < 14; day++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + day);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    let slots = [];
    try {
      const avail = await getAvailableSlotsForBarberDate(BARBER_ID, dateStr, BARBER_NAME);
      const list = Array.isArray(avail?.slots) ? avail.slots : [];
      slots = list.filter((s) => s && s.available !== false).map((s) => s.time || s.label || s);
    } catch {
      continue;
    }
    for (const label of slots) {
      if (!label) continue;
      if (preferExcludeYmdTime && preferExcludeYmdTime === `${dateStr}|${label}`) continue;
      const check = await validateBookingSlot(BARBER_ID, dateStr, label, BARBER_NAME, {
        durationMinutes: 30,
      });
      if (check.ok) {
        return {
          date: dateStr,
          time: label,
          timeSql: check.timeSql || null,
        };
      }
    }
  }
  return null;
}

async function countLogs(actionName, bookingId, result = null) {
  const params = [actionName];
  let sql = `SELECT COUNT(*)::int AS c FROM aura_action_logs WHERE action = $1`;
  if (bookingId) {
    params.push(bookingId);
    sql += ` AND booking_id = $${params.length}::uuid`;
  }
  if (result) {
    params.push(result);
    sql += ` AND result = $${params.length}`;
  }
  const r = await dbQuery(sql, params);
  return Number(r.rows?.[0]?.c || 0);
}

async function recentLogs(actionName, bookingId) {
  const r = await dbQuery(
    `SELECT id, action, result, metadata, created_at
     FROM aura_action_logs
     WHERE action = $1 AND booking_id = $2::uuid
     ORDER BY created_at DESC LIMIT 5`,
    [actionName, bookingId],
  );
  return r.rows || [];
}

async function bookingSnapshot(id) {
  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_id, barber_name, service,
            date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
            to_char(time, 'HH24:MI') AS time_24,
            booking_status, payment_status, is_paid_booking,
            total_price, amount, total_paid, amount_paid, notes
     FROM bookings WHERE id = $1::uuid`,
    [id],
  );
  return r.rows?.[0] || null;
}

async function slotStillAvailable(date, time, excludeBookingId = null) {
  const check = await validateBookingSlot(BARBER_ID, date, time, BARBER_NAME, {
    durationMinutes: 30,
    excludeBookingId,
  });
  return check;
}

async function runFind() {
  const flagsLive = await liveFlags();
  if (!flagsLive?.flags?.toolsEnabled) {
    return { ok: false, verdict: "FAIL", error: "toolsEnabled_false_on_live", flagsLive };
  }
  if (flagsLive?.flags?.dailyReportPreview || flagsLive?.flags?.dailyReportSend) {
    return { ok: false, verdict: "FAIL", error: "daily_report_flags_must_stay_false", flagsLive };
  }

  const slot = await pickFutureSlot();
  if (!slot) return { ok: false, verdict: "FAIL", error: "no_available_slot_for_seed" };

  const marker = `controlled_aura_tools_find_${Date.now()}`;
  const inserted = await dbQuery(
    `INSERT INTO bookings (
        customer_name, customer_email, barber_id, barber_name, service,
        date, time, amount, payment_status, booking_status, is_paid_booking,
        total_price, notes
      ) VALUES (
        $1, $2, $3::uuid, $4, $5,
        $6::date, $7::time, 0, 'unpaid', 'confirmed', false,
        0, $8
      )
      RETURNING id, customer_name, customer_email, barber_name, service,
                date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
                booking_status, payment_status, is_paid_booking`,
    [
      CUSTOMER_NAME,
      CUSTOMER_EMAIL,
      BARBER_ID,
      BARBER_NAME,
      SERVICE,
      slot.date,
      slot.timeSql || slot.time,
      `AURA tools FIND seed marker=${marker}`,
    ],
  );
  const seed = inserted.rows?.[0];
  if (!seed?.id) return { ok: false, verdict: "FAIL", error: "seed_insert_failed" };

  const before = await bookingSnapshot(seed.id);
  const logsBefore = await countLogs("find_booking", seed.id);

  const found = await findCustomerBooking(dbQuery, {
    bookingId: seed.id,
    customerEmail: CUSTOMER_EMAIL,
  });

  const after = await bookingSnapshot(seed.id);
  const logs = await recentLogs("find_booking", seed.id);
  const logsAfter = logs.length;

  const cross = await findCustomerBooking(dbQuery, {
    bookingId: seed.id,
    customerEmail: OTHER_EMAIL,
  });

  const identity = await assertBookingIdentity(dbQuery, after, {
    customerEmail: CUSTOMER_EMAIL,
    confirmBookingId: seed.id,
  });
  const identityBad = await assertBookingIdentity(dbQuery, after, {
    customerEmail: OTHER_EMAIL,
    confirmBookingId: seed.id,
  });

  const unchanged =
    before.booking_status === after.booking_status &&
    before.date === after.date &&
    before.time_24 === after.time_24 &&
    before.payment_status === after.payment_status &&
    String(before.is_paid_booking) === String(after.is_paid_booking);

  const checks = {
    toolsEnabled: flagsLive.flags.toolsEnabled === true,
    dailyReportsOff:
      flagsLive.flags.dailyReportPreview === false && flagsLive.flags.dailyReportSend === false,
    foundOk: found.ok === true && found.count >= 1,
    correctBooking: String(found.bookings?.[0]?.bookingId) === String(seed.id),
    noMutation: unchanged,
    oneFindLog: logsAfter - logsBefore === 1 || logsAfter === 1,
    findLogReadOnly: logs.every((l) => ["found", "not_found"].includes(l.result)),
    crossCustomerNotMatched: cross.ok === true && cross.count === 0,
    identityOk: identity.ok === true,
    identityRejectsOther: identityBad.ok === false,
  };

  const pass = Object.values(checks).every(Boolean);
  const state = saveState({
    phase: "find",
    findBookingId: seed.id,
    findSlot: { date: seed.date, time: seed.time_ampm },
    marker,
    findPass: pass,
  });

  return {
    ok: pass,
    verdict: pass ? "PASS" : "FAIL",
    action: "FIND_BOOKING",
    bookingId: seed.id,
    found,
    crossCustomerCount: cross.count,
    logs,
    checks,
    state,
  };
}

async function runCreate() {
  const flagsLive = await liveFlags();
  const deploy = await liveDeploy();
  const localFlags = auraPhase2Flags();
  if (!flagsLive?.flags?.toolsEnabled || !localFlags.toolsEnabled) {
    return { ok: false, verdict: "FAIL", error: "tools_disabled", flagsLive, localFlags };
  }

  // Free prior controlled rows so CREATE uses a distinct slot.
  const prev = loadState();
  for (const id of [prev.findBookingId, prev.bookingId].filter(Boolean)) {
    await dbQuery(
      `UPDATE bookings
       SET booking_status = 'cancelled',
           notes = COALESCE(notes,'') || ' | released_before_aura_tools_create'
       WHERE id = $1::uuid
         AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')`,
      [id],
    );
  }

  const slot = await pickFutureSlot();
  if (!slot) return { ok: false, verdict: "FAIL", error: "no_available_slot" };

  const beforeOccupied = await slotStillAvailable(slot.date, slot.time);
  if (!beforeOccupied.ok) {
    return { ok: false, verdict: "FAIL", error: "chosen_slot_not_available", beforeOccupied };
  }

  const create1 = await confirmBook(dbQuery, {
    confirm: true,
    barberId: BARBER_ID,
    barberName: BARBER_NAME,
    date: slot.date,
    time: slot.time,
    service: SERVICE,
    customerName: CUSTOMER_NAME,
    customerEmail: CUSTOMER_EMAIL,
    durationMinutes: 30,
  });

  if (!create1.ok || !create1.booking?.bookingId) {
    return { ok: false, verdict: "FAIL", error: "create_failed", create1, deploy };
  }

  const bookingId = create1.booking.bookingId;
  const row = await bookingSnapshot(bookingId);
  const create2 = await confirmBook(dbQuery, {
    confirm: true,
    barberId: BARBER_ID,
    barberName: BARBER_NAME,
    date: slot.date,
    time: slot.time,
    service: SERVICE,
    customerName: CUSTOMER_NAME,
    customerEmail: CUSTOMER_EMAIL,
    durationMinutes: 30,
  });

  const afterSlot = await slotStillAvailable(slot.date, slot.time);
  const createdLogs = await recentLogs("create_booking", bookingId);
  const createdCount = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM bookings
     WHERE barber_id = $1::uuid AND date = $2::date AND time = $3::time
       AND lower(coalesce(customer_email,'')) = $4
       AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')`,
    [BARBER_ID, slot.date, row.time_24, CUSTOMER_EMAIL],
  );

  const checks = {
    createOk: create1.ok === true && create1.idempotent !== true,
    paymentHoldNotCharged:
      ["pay_at_shop", "unpaid"].includes(String(row.payment_status || "").toLowerCase()) &&
      row.is_paid_booking === false,
    noCharge: Number(row.total_paid || 0) === 0 && Number(row.amount_paid || 0) === 0,
    detailsMatch:
      row.customer_email === CUSTOMER_EMAIL &&
      String(row.barber_id) === BARBER_ID &&
      row.service === SERVICE &&
      row.date === slot.date,
    oneRow: Number(createdCount.rows?.[0]?.c || 0) === 1,
    idempotentSecond:
      create2.ok === true &&
      (create2.idempotent === true || String(create2.booking?.bookingId) === String(bookingId)),
    slotNowUnavailable: afterSlot.ok === false,
    oneCreateLog: createdLogs.filter((l) => l.result === "created").length === 1,
    dailyReportsStillOff:
      flagsLive.flags.dailyReportPreview === false && flagsLive.flags.dailyReportSend === false,
  };

  const pass = Object.values(checks).every(Boolean);
  saveState({
    phase: "create",
    bookingId,
    createSlot: { date: row.date, time: row.time_ampm, time24: row.time_24 },
    createPass: pass,
  });

  return {
    ok: pass,
    verdict: pass ? "PASS" : "FAIL",
    action: "CREATE_BOOKING",
    bookingId,
    create1,
    create2,
    row,
    afterSlot,
    createdLogs,
    deployCommit: deploy?.activeCommitShort,
    checks,
  };
}

async function runReschedule() {
  const state = loadState();
  const bookingId = state.bookingId;
  if (!bookingId) return { ok: false, verdict: "FAIL", error: "missing_create_state" };

  const before = await bookingSnapshot(bookingId);
  if (!before || String(before.booking_status).toLowerCase() !== "confirmed") {
    return { ok: false, verdict: "FAIL", error: "booking_not_confirmed", before };
  }

  const oldDate = before.date;
  const oldTimeLabel = before.time_ampm;
  const newSlot = await pickFutureSlot(`${oldDate}|${oldTimeLabel}`);
  if (!newSlot) return { ok: false, verdict: "FAIL", error: "no_reschedule_slot" };

  // Unauthorized attempt must fail without mutation.
  const unauthorized = await confirmReschedule(dbQuery, {
    confirm: true,
    bookingId,
    customerEmail: OTHER_EMAIL,
    confirmBookingId: bookingId,
    newDate: newSlot.date,
    newTime: newSlot.time,
  });
  const afterUnauthorized = await bookingSnapshot(bookingId);

  const emailsBefore = await countLogs("hook_reschedule", bookingId);
  const toolLogsBefore = await countLogs("reschedule_booking", bookingId);

  const out = await confirmReschedule(dbQuery, {
    confirm: true,
    bookingId,
    customerEmail: CUSTOMER_EMAIL,
    confirmBookingId: bookingId,
    newDate: newSlot.date,
    newTime: newSlot.time,
  });

  await new Promise((r) => setTimeout(r, 800));
  const after = await bookingSnapshot(bookingId);
  const oldSlotNow = await slotStillAvailable(oldDate, oldTimeLabel, bookingId);
  const newSlotCheck = await slotStillAvailable(newSlot.date, newSlot.time);
  const toolLogs = await recentLogs("reschedule_booking", bookingId);
  const hookLogs = await recentLogs("hook_reschedule", bookingId);
  const dupRows = await dbQuery(
    `SELECT COUNT(*)::int AS c FROM bookings
     WHERE lower(coalesce(customer_email,'')) = $1
       AND COALESCE(notes,'') LIKE '%AURA tools%'
       AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')
       AND id <> $2::uuid
       AND date = $3::date`,
    [CUSTOMER_EMAIL, bookingId, after.date],
  );

  // Count customer reschedule emails via aura_action_logs metadata / hook result
  const customerEmailSends = hookLogs.filter((l) => {
    const r = l.metadata?.results?.customer;
    return r?.ok === true;
  }).length;

  const checks = {
    unauthorizedRejected: unauthorized.ok === false && unauthorized.error === "identity_unverified",
    unauthorizedNoMutation:
      afterUnauthorized.date === before.date && afterUnauthorized.time_24 === before.time_24,
    rescheduleOk: out.ok === true,
    moved: after.date === newSlot.date && after.date !== oldDate || after.time_ampm !== oldTimeLabel,
    oldSlotFreed: oldSlotNow.ok === true,
    newSlotReserved: newSlotCheck.ok === false,
    oneToolLog: toolLogs.filter((l) => l.result === "rescheduled").length === 1,
    oneCustomerRescheduleEmail: customerEmailSends === 1,
    noDuplicateBooking: Number(dupRows.rows?.[0]?.c || 0) === 0,
    paymentUnchanged:
      after.payment_status === before.payment_status &&
      String(after.is_paid_booking) === String(before.is_paid_booking),
  };

  const pass = Object.values(checks).every(Boolean);
  saveState({
    phase: "reschedule",
    bookingId,
    rescheduleFrom: { date: oldDate, time: oldTimeLabel },
    rescheduleTo: { date: after.date, time: after.time_ampm },
    reschedulePass: pass,
  });

  return {
    ok: pass,
    verdict: pass ? "PASS" : "FAIL",
    action: "RESCHEDULE_BOOKING",
    bookingId,
    unauthorized,
    out,
    before,
    after,
    oldSlotNow,
    newSlotCheck,
    toolLogs,
    hookLogs,
    checks,
  };
}

async function runCancel() {
  const state = loadState();
  const bookingId = state.bookingId;
  if (!bookingId) return { ok: false, verdict: "FAIL", error: "missing_create_state" };

  const before = await bookingSnapshot(bookingId);
  if (!before) return { ok: false, verdict: "FAIL", error: "booking_missing" };

  const unauthorized = await confirmCancel(dbQuery, {
    confirm: true,
    bookingId,
    customerEmail: OTHER_EMAIL,
    confirmBookingId: bookingId,
  });
  const afterUnauthorized = await bookingSnapshot(bookingId);

  const out = await confirmCancel(dbQuery, {
    confirm: true,
    bookingId,
    customerEmail: CUSTOMER_EMAIL,
    confirmBookingId: bookingId,
    reason: "Controlled AURA tools cancel test",
  });

  await new Promise((r) => setTimeout(r, 800));
  const after = await bookingSnapshot(bookingId);
  const slotFree = await slotStillAvailable(before.date, before.time_ampm, bookingId);
  const toolLogs = await recentLogs("cancel_booking", bookingId);
  const hookLogs = await recentLogs("hook_cancel", bookingId);
  const stillExists = Boolean(after?.id);
  const customerCancelEmails = hookLogs.filter((l) => l.metadata?.results?.customer?.ok === true)
    .length;

  // Cleanup any leftover FIND seed if present
  if (state.findBookingId && state.findBookingId !== bookingId) {
    await dbQuery(
      `UPDATE bookings SET booking_status = 'cancelled',
         notes = COALESCE(notes,'') || ' | cleaned_after_aura_tools_test'
       WHERE id = $1::uuid AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')`,
      [state.findBookingId],
    );
  }

  const checks = {
    unauthorizedRejected: unauthorized.ok === false && unauthorized.error === "identity_unverified",
    unauthorizedStillActive:
      String(afterUnauthorized.booking_status || "").toLowerCase() !== "cancelled",
    cancelOk: out.ok === true,
    statusCancelled: String(after.booking_status).toLowerCase() === "cancelled",
    slotAvailable: slotFree.ok === true,
    oneCancelLog: toolLogs.filter((l) => l.result === "cancelled").length === 1,
    oneCustomerCancelEmail: customerCancelEmails === 1,
    recordNotDeleted: stillExists,
    noPaymentChange:
      after.payment_status === before.payment_status &&
      String(after.is_paid_booking) === String(before.is_paid_booking) &&
      String(after.total_paid ?? "") === String(before.total_paid ?? ""),
    noRefundAction: toolLogs.every((l) => !/refund/i.test(JSON.stringify(l))),
  };

  const pass = Object.values(checks).every(Boolean);
  saveState({ phase: "cancel", cancelPass: pass, done: true });

  return {
    ok: pass,
    verdict: pass ? "PASS" : "FAIL",
    action: "CANCEL_BOOKING",
    bookingId,
    unauthorized,
    out,
    before,
    after,
    slotFree,
    toolLogs,
    hookLogs,
    checks,
  };
}

async function runStatus() {
  const flagsLive = await liveFlags();
  const deploy = await liveDeploy();
  return {
    ok: true,
    action: "STATUS",
    flagsLive,
    deploy: {
      service: deploy?.service,
      activeCommitShort: deploy?.activeCommitShort,
    },
    state: loadState(),
    localFlags: auraPhase2Flags(),
  };
}

let result;
switch (action) {
  case "find":
    result = await runFind();
    break;
  case "create":
    result = await runCreate();
    break;
  case "reschedule":
    result = await runReschedule();
    break;
  case "cancel":
    result = await runCancel();
    break;
  case "status":
  default:
    result = await runStatus();
    break;
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
