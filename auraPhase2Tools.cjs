/**
 * AURA Phase 2 guarded booking tools.
 * Sensitive actions are denied; mutations require identity confirmation.
 * Does not alter prices, issue refunds, delete records, or change admin permissions.
 */
const { auraPhase2Flags, auraReceptionistIdentity } = require("./auraPhase2Flags.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

const DENIED_ACTIONS = new Set([
  "refund",
  "issue_refund",
  "alter_price",
  "change_price",
  "delete_record",
  "delete_booking_hard",
  "change_admin_permissions",
  "modify_payment_credentials",
  "update_paypal_credentials",
  "reset_database",
]);

function denySensitive(action) {
  const a = String(action || "").trim().toLowerCase();
  if (DENIED_ACTIONS.has(a) || /refund|password|credential|permission|delete.*admin/i.test(a)) {
    return {
      ok: false,
      denied: true,
      escalate: true,
      message: `${auraReceptionistIdentity()} cannot perform "${a}" without Super Admin approval. Please contact the shop Super Admin.`,
    };
  }
  return null;
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function bookingSummary(row) {
  if (!row) return null;
  return {
    bookingId: row.id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    barberName: row.barber_name,
    service: row.service,
    date: row.date,
    time: row.time,
    status: row.booking_status || row.status,
    price: row.total_paid ?? row.amount_paid ?? row.total_price ?? null,
  };
}

async function findCustomerBooking(dbQuery, { bookingId, customerEmail, userId } = {}) {
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) {
    return { ok: false, error: "aura_phase2_tools_disabled" };
  }
  const id = String(bookingId || "").trim();
  const email = normalizeEmail(customerEmail);
  const uid = userId ? String(userId).trim() : "";
  if (!id && !email && !uid) {
    return {
      ok: false,
      error: "identity_required",
      message: "Provide booking reference and/or customer email.",
    };
  }

  const params = [];
  let sql = `SELECT id, customer_name, customer_email, barber_name, service,
                    date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                    booking_status, barber_id, user_id,
                    total_paid, amount_paid, total_price
             FROM bookings WHERE 1=1`;
  if (id) {
    params.push(id);
    sql += ` AND id = $${params.length}::uuid`;
  }
  if (email) {
    params.push(email);
    sql += ` AND lower(coalesce(customer_email,'')) = $${params.length}`;
  }
  if (uid) {
    params.push(uid);
    sql += ` AND user_id = $${params.length}::uuid`;
  }
  sql += ` ORDER BY date DESC, time DESC LIMIT 5`;

  const r = await dbQuery(sql, params);
  const rows = r.rows || [];
  await logAuraAction(dbQuery, {
    action: "find_booking",
    userId: uid || null,
    bookingId: rows[0]?.id || id || null,
    result: rows.length ? "found" : "not_found",
    metadata: { count: rows.length },
  });
  return {
    ok: true,
    count: rows.length,
    bookings: rows.map(bookingSummary),
    message: rows.length
      ? `Found ${rows.length} booking(s).`
      : "No matching booking found. Please verify the booking reference and email.",
  };
}

/**
 * Identity gate: authenticated userId match OR email+bookingId match.
 */
async function assertBookingIdentity(dbQuery, booking, { userId, customerEmail, confirmBookingId } = {}) {
  if (!booking) return { ok: false, error: "not_found" };
  const uid = userId ? String(userId).trim() : "";
  if (uid && booking.user_id && String(booking.user_id) === uid) {
    return { ok: true, method: "user_id" };
  }
  const email = normalizeEmail(customerEmail);
  const ref = String(confirmBookingId || booking.id || "").trim();
  if (
    email &&
    ref &&
    normalizeEmail(booking.customer_email) === email &&
    String(booking.id) === ref
  ) {
    return { ok: true, method: "email_and_reference" };
  }
  return {
    ok: false,
    error: "identity_unverified",
    message:
      "Please confirm your email and booking reference before I can change this appointment.",
  };
}

async function loadBookingById(dbQuery, id) {
  const r = await dbQuery(
    `SELECT id, customer_name, customer_email, barber_name, service, barber_id, user_id,
            date::text AS date, to_char(time, 'HH12:MI AM') AS time, booking_status,
            service_duration_minutes, total_paid, amount_paid, total_price,
            to_char(time, 'HH24:MI') AS time_24
     FROM bookings WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  return r.rows?.[0] || null;
}

async function proposeCancel(dbQuery, opts = {}) {
  const denied = denySensitive(opts.action || "cancel_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };

  const id = String(opts.bookingId || "").trim();
  if (!id) return { ok: false, error: "booking_id_required" };
  const booking = await loadBookingById(dbQuery, id);
  if (!booking) return { ok: false, error: "not_found" };
  const idGate = await assertBookingIdentity(dbQuery, booking, opts);
  if (!idGate.ok) return idGate;

  return {
    ok: true,
    requiresConfirmation: true,
    action: "cancel_booking",
    booking: bookingSummary(booking),
    message: `I can cancel this appointment for ${booking.customer_name} on ${booking.date} at ${booking.time}. Reply confirm to proceed.`,
  };
}

async function confirmCancel(dbQuery, opts = {}) {
  const denied = denySensitive("cancel_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };
  if (opts.confirm !== true && String(opts.confirmToken || "").toLowerCase() !== "confirm") {
    return {
      ok: false,
      error: "confirmation_required",
      message: "Say confirm to cancel the appointment.",
    };
  }

  const proposed = await proposeCancel(dbQuery, opts);
  if (!proposed.ok || proposed.requiresConfirmation !== true) return proposed;

  const id = proposed.booking.bookingId;
  // Soft-cancel only — never refund, delete, or mutate payment/price fields.
  const upd = await dbQuery(
    `UPDATE bookings
     SET booking_status = 'cancelled',
         cancelled_at = COALESCE(cancelled_at, NOW()),
         cancellation_reason = COALESCE($2, cancellation_reason)
     WHERE id = $1::uuid
       AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')
     RETURNING id, customer_name, customer_email, phone, barber_name, service, barber_id, user_id,
               date::text AS date, to_char(time, 'HH12:MI AM') AS time,
               booking_status, total_paid, amount_paid, total_price,
               payment_status, is_paid_booking`,
    [id, String(opts.reason || "Cancelled via AURA").slice(0, 500)],
  );
  const row = upd.rows?.[0];
  if (!row) {
    await logAuraAction(dbQuery, { action: "cancel_booking", bookingId: id, result: "noop" });
    return { ok: false, error: "already_cancelled_or_missing" };
  }

  await logAuraAction(dbQuery, {
    action: "cancel_booking",
    bookingId: id,
    userId: opts.userId || null,
    result: "cancelled",
    metadata: { reason: String(opts.reason || "Cancelled via AURA").slice(0, 200) },
  });

  try {
    const { afterBookingCancelled } = require("./auraPhase2Hooks.cjs");
    await afterBookingCancelled(dbQuery, row, { reason: opts.reason || "Cancelled via AURA" });
  } catch (e) {
    console.warn("[aura-tools] cancel hook failed:", e?.message || e);
  }

  return {
    ok: true,
    booking: bookingSummary(row),
    message: `Done. I cancelled booking ${String(id).slice(0, 8)} and sent a confirmation email.`,
  };
}

async function proposeReschedule(dbQuery, opts = {}) {
  const denied = denySensitive("reschedule_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };

  const id = String(opts.bookingId || "").trim();
  const newDate = String(opts.newDate || "").trim();
  const newTime = String(opts.newTime || "").trim();
  if (!id || !newDate || !newTime) {
    return {
      ok: false,
      error: "missing_fields",
      message: "I need the booking reference, new date (YYYY-MM-DD), and new time.",
    };
  }

  const booking = await loadBookingById(dbQuery, id);
  if (!booking) return { ok: false, error: "not_found" };
  const idGate = await assertBookingIdentity(dbQuery, booking, opts);
  if (!idGate.ok) return idGate;

  try {
    const { validateBookingSlot } = await import("./barberSlotEngine.js");
    const slotCheck = await validateBookingSlot(
      booking.barber_id,
      newDate,
      newTime,
      booking.barber_name || "",
      {
        excludeBookingId: id,
        durationMinutes: Number(booking.service_duration_minutes) || 30,
      },
    );
    if (!slotCheck.ok) {
      return {
        ok: false,
        error: slotCheck.code || "slot_unavailable",
        message: slotCheck.message || "That time is not available.",
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: "slot_check_failed",
      message: e?.message || "Could not verify that time slot.",
    };
  }

  return {
    ok: true,
    requiresConfirmation: true,
    action: "reschedule_booking",
    booking: bookingSummary(booking),
    proposed: { date: newDate, time: newTime },
    message: `I can move this appointment to ${newDate} at ${newTime}. Reply confirm to proceed.`,
  };
}

async function confirmReschedule(dbQuery, opts = {}) {
  const denied = denySensitive("reschedule_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };
  if (opts.confirm !== true && String(opts.confirmToken || "").toLowerCase() !== "confirm") {
    return {
      ok: false,
      error: "confirmation_required",
      message: "Say confirm to reschedule the appointment.",
    };
  }

  const proposed = await proposeReschedule(dbQuery, opts);
  if (!proposed.ok || proposed.requiresConfirmation !== true) return proposed;

  const id = proposed.booking.bookingId;
  const newDate = proposed.proposed.date;
  const newTime = proposed.proposed.time;
  const fromLabel = `${proposed.booking.date} ${proposed.booking.time}`;

  let timeSql = newTime;
  try {
    const { validateBookingSlot, slotLabelToSqlTime } = await import("./barberSlotEngine.js");
    const booking = await loadBookingById(dbQuery, id);
    const slotCheck = await validateBookingSlot(
      booking.barber_id,
      newDate,
      newTime,
      booking.barber_name || "",
      {
        excludeBookingId: id,
        durationMinutes: Number(booking.service_duration_minutes) || 30,
      },
    );
    if (!slotCheck.ok) {
      return {
        ok: false,
        error: slotCheck.code || "slot_unavailable",
        message: slotCheck.message || "That time is not available.",
      };
    }
    timeSql = slotCheck.timeSql || slotLabelToSqlTime(newTime) || newTime;
  } catch (e) {
    return { ok: false, error: "slot_check_failed", message: e?.message || String(e) };
  }

  let upd;
  try {
    upd = await dbQuery(
      `UPDATE bookings
       SET date = $2::date,
           time = $3::time,
           booking_status = 'confirmed',
           rescheduled_from_date = COALESCE(rescheduled_from_date, date),
           rescheduled_from_time = COALESCE(rescheduled_from_time, time),
           rescheduled_to_date = $2::date,
           rescheduled_to_time = $3::time,
           rescheduled_by = 'aura',
           rescheduled_at = NOW()
       WHERE id = $1::uuid
         AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled','completed')
       RETURNING id, customer_name, customer_email, phone, barber_name, service, barber_id, user_id,
                 date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                 booking_status, total_paid, amount_paid, total_price`,
      [id, newDate, timeSql],
    );
  } catch (sqlErr) {
    if (sqlErr?.code === "23505") {
      return {
        ok: false,
        error: "slot_taken",
        message: "That time was just booked — pick another slot.",
      };
    }
    throw sqlErr;
  }

  const row = upd.rows?.[0];
  if (!row) return { ok: false, error: "reschedule_failed" };

  await logAuraAction(dbQuery, {
    action: "reschedule_booking",
    bookingId: id,
    userId: opts.userId || null,
    result: "rescheduled",
    metadata: { fromLabel, to: `${newDate} ${row.time}` },
  });

  // Hook owns the single customer reschedule email when AURA_PHASE2_RESCHEDULE_EMAIL is on.
  try {
    const { afterBookingRescheduled } = require("./auraPhase2Hooks.cjs");
    await afterBookingRescheduled(dbQuery, row, {
      fromLabel,
      newDate: row.date,
      newTime: row.time,
    });
  } catch (e) {
    console.warn("[aura-tools] reschedule hook failed:", e?.message || e);
  }

  return {
    ok: true,
    booking: bookingSummary(row),
    message: `Done. I moved your appointment to ${row.date} at ${row.time}.`,
  };
}

/**
 * Propose a new unpaid hold booking. Never charges PayPal / never invents captures.
 * confirmBook writes one unpaid confirmed row so the slot is reserved.
 */
async function proposeBook(dbQuery, opts = {}) {
  const denied = denySensitive("create_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };

  const barberId = opts.barberId;
  const barberName = String(opts.barberName || "").trim();
  const date = String(opts.date || "").trim();
  const time = String(opts.time || "").trim();
  const service = String(opts.service || "Appointment").trim();
  const customerName = String(opts.customerName || "").trim();
  const customerEmail = normalizeEmail(opts.customerEmail);
  const customerPhone = String(opts.phone || opts.customerPhone || "").trim();
  const durationMinutes = Number(opts.durationMinutes) || 30;

  if (!barberId || !date || !time || !customerName || !customerEmail) {
    return {
      ok: false,
      error: "missing_fields",
      message:
        "I need your name, email, barber, date (YYYY-MM-DD), and time before I can prepare a booking.",
    };
  }

  let timeSql = null;
  try {
    const { validateBookingSlot, slotLabelToSqlTime } = await import("./barberSlotEngine.js");
    const slotCheck = await validateBookingSlot(barberId, date, time, barberName, {
      durationMinutes,
    });
    if (!slotCheck.ok) {
      return {
        ok: false,
        error: slotCheck.code || "slot_unavailable",
        message: slotCheck.message || "That time is not available.",
      };
    }
    timeSql = slotCheck.timeSql || slotLabelToSqlTime(time) || time;
  } catch (e) {
    return { ok: false, error: "slot_check_failed", message: e?.message || String(e) };
  }

  const prefill = {
    barberId,
    barberName,
    date,
    time,
    timeSql,
    service,
    customerName,
    customerEmail,
    customerPhone,
    durationMinutes,
  };

  await logAuraAction(dbQuery, {
    action: "propose_book",
    result: "proposed",
    metadata: { barberId, date, time, customerEmail },
  });

  return {
    ok: true,
    requiresConfirmation: true,
    action: "create_booking",
    prefill,
    message: `I can reserve ${service} with ${barberName || "your barber"} on ${date} at ${time} for ${customerName}. Reply confirm — I will hold the unpaid slot only (no payment charged).`,
  };
}

async function confirmBook(dbQuery, opts = {}) {
  const denied = denySensitive("create_booking");
  if (denied) return denied;
  const flags = auraPhase2Flags();
  if (!flags.toolsEnabled) return { ok: false, error: "aura_phase2_tools_disabled" };
  if (opts.confirm !== true && String(opts.confirmToken || "").toLowerCase() !== "confirm") {
    return {
      ok: false,
      error: "confirmation_required",
      message: "Say confirm to reserve this unpaid appointment slot.",
    };
  }

  const barberId = opts.barberId;
  const date = String(opts.date || "").trim();
  const time = String(opts.time || "").trim();
  const customerEmail = normalizeEmail(opts.customerEmail);
  let timeSql = time;
  try {
    const { slotLabelToSqlTime } = await import("./barberSlotEngine.js");
    timeSql = slotLabelToSqlTime(time) || time;
  } catch {
    /* keep raw time */
  }

  // Idempotent check before slot re-validation so repeats do not look "taken".
  if (barberId && date && timeSql && customerEmail) {
    const existing = await dbQuery(
      `SELECT id, customer_name, customer_email, barber_name, service, barber_id, user_id,
              date::text AS date, to_char(time, 'HH12:MI AM') AS time,
              booking_status, total_paid, amount_paid, total_price, payment_status, is_paid_booking
       FROM bookings
       WHERE barber_id = $1::uuid
         AND date = $2::date
         AND time = $3::time
         AND lower(coalesce(customer_email,'')) = $4
         AND COALESCE(booking_status,'') NOT IN ('cancelled','canceled')
       ORDER BY id DESC
       LIMIT 1`,
      [barberId, date, timeSql, customerEmail],
    );
    if (existing.rows?.[0]) {
      const row = existing.rows[0];
      await logAuraAction(dbQuery, {
        action: "create_booking",
        bookingId: row.id,
        result: "idempotent_existing",
        metadata: { date, time },
      });
      return {
        ok: true,
        booking: bookingSummary(row),
        idempotent: true,
        paymentCharged: false,
        message: `That unpaid hold already exists (ref ${String(row.id).slice(0, 8)}).`,
      };
    }
  }

  const proposed = await proposeBook(dbQuery, opts);
  if (!proposed.ok || proposed.requiresConfirmation !== true) return proposed;

  const p = proposed.prefill;
  timeSql = p.timeSql || p.time;

  let inserted;
  try {
    inserted = await dbQuery(
      `INSERT INTO bookings (
          customer_name, customer_email, phone, barber_id, barber_name, service,
          date, time, amount, payment_status, booking_status, is_paid_booking,
          total_price, service_duration_minutes, notes, booking_source
        ) VALUES (
          $1, $2, $3, $4::uuid, $5, $6,
          $7::date, $8::time, 0, 'pay_at_shop', 'confirmed', false,
          0, $9, $10, 'aura_tools'
        )
        RETURNING id, customer_name, customer_email, phone, barber_name, service, barber_id, user_id,
                  date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                  booking_status, total_paid, amount_paid, total_price, payment_status, is_paid_booking`,
      [
        p.customerName,
        p.customerEmail,
        p.customerPhone || null,
        p.barberId,
        p.barberName || "your barber",
        p.service,
        p.date,
        timeSql,
        p.durationMinutes || 30,
        `AURA tools unpaid hold — no payment charged`,
      ],
    );
  } catch (sqlErr) {
    if (sqlErr?.code === "23505") {
      return {
        ok: false,
        error: "slot_taken",
        message: "That time was just booked — pick another slot.",
      };
    }
    // booking_source column may be absent on older DBs — retry without it.
    if (/booking_source/i.test(String(sqlErr?.message || ""))) {
      inserted = await dbQuery(
        `INSERT INTO bookings (
            customer_name, customer_email, phone, barber_id, barber_name, service,
            date, time, amount, payment_status, booking_status, is_paid_booking,
            total_price, service_duration_minutes, notes
          ) VALUES (
            $1, $2, $3, $4::uuid, $5, $6,
            $7::date, $8::time, 0, 'pay_at_shop', 'confirmed', false,
            0, $9, $10
          )
          RETURNING id, customer_name, customer_email, phone, barber_name, service, barber_id, user_id,
                    date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                    booking_status, total_paid, amount_paid, total_price, payment_status, is_paid_booking`,
        [
          p.customerName,
          p.customerEmail,
          p.customerPhone || null,
          p.barberId,
          p.barberName || "your barber",
          p.service,
          p.date,
          timeSql,
          p.durationMinutes || 30,
          `AURA tools unpaid hold — no payment charged`,
        ],
      );
    } else {
      throw sqlErr;
    }
  }

  const row = {
    ...(inserted.rows?.[0] || {}),
    phone: inserted.rows?.[0]?.phone || p.customerPhone || opts.phone || opts.customerPhone || null,
  };
  if (!row.id) return { ok: false, error: "create_failed" };

  await logAuraAction(dbQuery, {
    action: "create_booking",
    bookingId: row.id,
    result: "created",
    metadata: {
      unpaidHold: true,
      paymentCharged: false,
      date: row.date,
      time: row.time,
      to: row.customer_email,
    },
  });

  try {
    const { afterBookingCreated } = require("./auraPhase2Hooks.cjs");
    await afterBookingCreated(dbQuery, row);
  } catch (e) {
    console.warn("[aura-tools] create hook failed:", e?.message || e);
  }

  return {
    ok: true,
    booking: bookingSummary(row),
    paymentCharged: false,
    message: `Done. I reserved an unpaid hold (pay at shop) for ${row.date} at ${row.time} (ref ${String(row.id).slice(0, 8)}). No payment was charged.`,
  };
}

function escalateMessage(action) {
  return (
    denySensitive(action) || {
      ok: false,
      escalate: true,
      message: `${auraReceptionistIdentity()} must escalate "${action}" to Super Admin.`,
    }
  );
}

async function dispatchAuraTool(dbQuery, toolName, opts = {}) {
  const name = String(toolName || "").trim().toLowerCase();
  const denied = denySensitive(name);
  if (denied) return denied;

  switch (name) {
    case "find_booking":
      return findCustomerBooking(dbQuery, opts);
    case "propose_cancel":
    case "cancel_booking_propose":
      return proposeCancel(dbQuery, opts);
    case "cancel_booking":
    case "confirm_cancel":
      return confirmCancel(dbQuery, opts);
    case "propose_reschedule":
      return proposeReschedule(dbQuery, opts);
    case "reschedule_booking":
    case "confirm_reschedule":
      return confirmReschedule(dbQuery, opts);
    case "propose_book":
      return proposeBook(dbQuery, opts);
    case "confirm_book":
    case "create_booking":
      return confirmBook(dbQuery, opts);
    default:
      return {
        ok: false,
        error: "unknown_tool",
        message: `${auraReceptionistIdentity()} does not recognize that action.`,
      };
  }
}

module.exports = {
  DENIED_ACTIONS,
  denySensitive,
  findCustomerBooking,
  assertBookingIdentity,
  proposeCancel,
  confirmCancel,
  proposeReschedule,
  confirmReschedule,
  proposeBook,
  confirmBook,
  escalateMessage,
  bookingSummary,
  dispatchAuraTool,
};
