/**
 * Super Admin Manual Booking (Bypass Mode) — create / convert / cancel.
 * Only platform Super Admin (isSuperAdmin / isOwner JWT) may call these helpers.
 */
import { createRequire } from "module";
import { dbQuery } from "./db.js";
import { ensureManualBypassBookingColumns } from "./manualBypassBookingMigrations.js";
import { BARBER_PLATFORM_FEE_USD } from "./subscriptionTier.js";
import { logAdminActivity } from "./adminActivityLog.js";

const require = createRequire(import.meta.url);
const { resolveBarberIdentity, barberIdForTable } = require("./barberIdentity.cjs");
const { PAYMENT_STATUS } = require("./bookingPaymentSettlement.cjs");

export const BYPASS_PAYMENT_TYPES = Object.freeze({
  PAID_ONLINE: "paid_online",
  COMPLIMENTARY: "complimentary",
  PAY_AT_SHOP: "pay_at_shop",
  STAFF_TRAINING: "staff_training",
});

const BYPASS_SET = new Set(Object.values(BYPASS_PAYMENT_TYPES));

export function isBypassPaymentType(value) {
  return BYPASS_SET.has(String(value || "").trim().toLowerCase());
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function text(v) {
  return String(v ?? "").trim();
}

function ymd(v) {
  const s = text(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function hhmm(v) {
  const s = text(v);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

/** Normalize time label like "1:00 PM" → HH:MM */
function normalizeTimeLabel(v) {
  const raw = text(v);
  const direct = hhmm(raw);
  if (direct) return direct;
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/** Convert HH:MM (24h) or already-labeled time into slot-engine label ("1:00 PM"). */
export function toSlotEngineTimeLabel(v) {
  const raw = text(v);
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw)) {
    return raw.replace(/\s+/g, " ").toUpperCase().replace(/\s*(AM|PM)$/i, " $1");
  }
  const hh = normalizeTimeLabel(raw);
  if (!hh) return null;
  const [hStr, min] = hh.split(":");
  let h = Number(hStr);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${ap}`;
}

export function requireSuperAdminActor(req) {
  const user = req?.user || null;
  if (!user) return { ok: false, status: 401, message: "Authentication required" };
  if (user.isSuperAdmin === true || user.isOwner === true) return { ok: true, user };
  const role = String(user.role || "").trim().toLowerCase();
  if (role === "super_admin") return { ok: true, user };
  return {
    ok: false,
    status: 403,
    message: "Manual Booking (Bypass Mode) is restricted to Super Admin only.",
  };
}

async function resolveBarber(barberIdRaw, barberNameRaw) {
  const id = text(barberIdRaw);
  const nameHint = text(barberNameRaw);
  if (id) {
    const byId = await dbQuery(
      `SELECT id::text AS id, name, business_id FROM barbers WHERE id::text = $1 LIMIT 1`,
      [id],
    ).catch(() => ({ rows: [] }));
    if (byId.rows?.[0]) return byId.rows[0];
  }
  if (nameHint) {
    const byName = await dbQuery(
      `SELECT id::text AS id, name, business_id FROM barbers WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`,
      [nameHint],
    ).catch(() => ({ rows: [] }));
    if (byName.rows?.[0]) return byName.rows[0];
  }
  return null;
}

async function resolveOrCreateClientUser({
  clientUserId,
  customerName,
  customerEmail,
  createClient,
}) {
  const email = text(customerEmail).toLowerCase();
  if (clientUserId) {
    const u = await dbQuery(
      `SELECT id, name, email FROM app_users WHERE id = $1::uuid LIMIT 1`,
      [String(clientUserId)],
    );
    if (u.rows?.[0]) {
      return {
        userId: String(u.rows[0].id),
        name: text(u.rows[0].name) || customerName || "Client",
        email: text(u.rows[0].email) || email,
      };
    }
  }
  if (email && email.includes("@")) {
    const existing = await dbQuery(
      `SELECT id, name, email FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
      [email],
    );
    if (existing.rows?.[0]) {
      return {
        userId: String(existing.rows[0].id),
        name: text(existing.rows[0].name) || customerName || "Client",
        email: text(existing.rows[0].email),
      };
    }
    if (createClient) {
      const name = text(customerName) || email.split("@")[0] || "Client";
      const ins = await dbQuery(
        `INSERT INTO app_users (name, email, role, password_hash)
         VALUES ($1, $2, 'user', NULL)
         RETURNING id, name, email`,
        [name, email],
      ).catch(async () => {
        // Some schemas require password_hash NOT NULL — use unusable placeholder hash.
        const { hashPassword } = await import("./authPasswordPolicy.js");
        const ph = await hashPassword(`Bypass!${Date.now()}Aa1`);
        return dbQuery(
          `INSERT INTO app_users (name, email, role, password_hash)
           VALUES ($1, $2, 'user', $3)
           RETURNING id, name, email`,
          [name, email, ph],
        );
      });
      if (ins.rows?.[0]) {
        return {
          userId: String(ins.rows[0].id),
          name: text(ins.rows[0].name),
          email: text(ins.rows[0].email),
        };
      }
    }
  }
  return {
    userId: null,
    name: text(customerName) || "Client",
    email: email || null,
  };
}

async function resolveService(barberId, serviceId, serviceName, servicePrice) {
  const sid = text(serviceId);
  if (sid) {
    const r = await dbQuery(
      `SELECT id::text AS id, title, price, duration_minutes
       FROM styles WHERE id::text = $1 LIMIT 1`,
      [sid],
    ).catch(() => ({ rows: [] }));
    if (r.rows?.[0]) {
      return {
        id: r.rows[0].id,
        title: text(r.rows[0].title) || "Service",
        price: round2(r.rows[0].price),
        durationMinutes: Math.max(1, Number(r.rows[0].duration_minutes) || 30),
      };
    }
  }
  const title = text(serviceName) || "Appointment";
  const price = round2(servicePrice);
  return { id: null, title, price: price > 0 ? price : 0, durationMinutes: 30 };
}

/**
 * Create a Super Admin bypass booking.
 * @returns {{ ok: true, booking: object, paypal?: object } | { ok: false, status: number, message: string, code?: string }}
 */
export async function createManualBypassBooking({
  actor,
  body,
  sendBookingEmail,
  startPaidOnlineCheckout,
} = {}) {
  await ensureManualBypassBookingColumns(dbQuery);

  const bypassType = text(body?.paymentType || body?.bypassPaymentType || body?.payment_type).toLowerCase();
  if (!isBypassPaymentType(bypassType)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payment_type",
      message: `paymentType must be one of: ${[...BYPASS_SET].join(", ")}`,
    };
  }

  const dateStr = ymd(body?.date || body?.dateLabel);
  const timeStr = normalizeTimeLabel(body?.time || body?.timeLabel);
  const slotTimeLabel = toSlotEngineTimeLabel(body?.time || body?.timeLabel || timeStr);
  if (!dateStr || !timeStr || !slotTimeLabel) {
    return { ok: false, status: 400, message: "Valid date (YYYY-MM-DD) and time are required" };
  }

  const resolved = await resolveBarberIdentity(
    dbQuery,
    body?.barberId || body?.barber_id || "",
    body?.barberName || body?.barber || "",
  );
  let insertBarberId = resolved ? await barberIdForTable(dbQuery, "bookings", resolved) : null;
  let barberName = text(resolved?.barberName || body?.barberName || body?.barber);
  let businessId = resolved?.businessId ?? null;
  let barberKey = resolved?.barberUuid || resolved?.barberDbId || body?.barberId || body?.barber_id;

  if (insertBarberId == null) {
    const fallback = await resolveBarber(body?.barberId || body?.barber_id, body?.barberName || body?.barber);
    if (!fallback?.id) {
      return { ok: false, status: 400, message: "Barber not found" };
    }
    insertBarberId = fallback.id;
    barberName = fallback.name || barberName;
    businessId = fallback.business_id ?? businessId;
    barberKey = fallback.id;
  }
  if (!barberName) {
    return { ok: false, status: 400, message: "Barber name required" };
  }

  const createClient = body?.createClient === true || body?.create_client === true;
  const client = await resolveOrCreateClientUser({
    clientUserId: body?.clientUserId || body?.userId || body?.client_id,
    customerName: body?.customerName || body?.clientName || body?.name,
    customerEmail: body?.customerEmail || body?.clientEmail || body?.email,
    createClient,
  });
  if (!client.email || !client.email.includes("@")) {
    return { ok: false, status: 400, message: "Client email is required" };
  }

  const service = await resolveService(
    barberKey,
    body?.serviceId || body?.styleId,
    body?.service || body?.serviceName,
    body?.price ?? body?.servicePrice,
  );

  const notes = text(body?.notes || body?.appointmentNotes || body?.appointment_notes) || null;
  const reason = text(body?.reason || body?.bypassReason || body?.bypass_reason) || null;

  const { validateBookingSlot } = await import("./barberSlotEngine.js");
  const slotCheck = await validateBookingSlot(barberKey, dateStr, slotTimeLabel, barberName, {
    durationMinutes: service.durationMinutes,
  });
  if (!slotCheck.ok) {
    return {
      ok: false,
      status: 409,
      code: slotCheck.code || "slot_unavailable",
      message: slotCheck.message || "That time is not available.",
    };
  }

  let haircutPrice = service.price;
  let platformFee = 0;
  let total = haircutPrice;
  let amountPaid = 0;
  let remaining = haircutPrice;
  let paymentStatus = "unpaid";
  let bookingStatus = "confirmed";
  let isPaidBooking = false;
  let paymentProvider = "manual_bypass";
  let paymentType = "full";

  if (bypassType === BYPASS_PAYMENT_TYPES.COMPLIMENTARY) {
    haircutPrice = 0;
    total = 0;
    amountPaid = 0;
    remaining = 0;
    platformFee = 0;
    paymentStatus = "complimentary";
  } else if (bypassType === BYPASS_PAYMENT_TYPES.STAFF_TRAINING) {
    haircutPrice = 0;
    total = 0;
    amountPaid = 0;
    remaining = 0;
    platformFee = 0;
    paymentStatus = "staff_training";
  } else if (bypassType === BYPASS_PAYMENT_TYPES.PAY_AT_SHOP) {
    platformFee = 0;
    total = haircutPrice;
    amountPaid = 0;
    remaining = haircutPrice;
    paymentStatus = "pay_at_shop";
  } else if (bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE) {
    platformFee = round2(BARBER_PLATFORM_FEE_USD);
    total = round2(haircutPrice + platformFee);
    amountPaid = 0;
    remaining = total;
    paymentStatus = "unpaid";
    bookingStatus = "pending_payment";
    paymentProvider = "paypal";
    isPaidBooking = false;
  }

  const tipAmount = round2(body?.tipAmount ?? body?.tip_amount ?? 0);
  if (bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE && tipAmount > 0) {
    total = round2(total + tipAmount);
    remaining = total;
  }

  const barberPayout = round2(Math.max(0, haircutPrice - platformFee) + tipAmount);
  const actorEmail = text(actor?.email) || null;
  const actorId = actor?.id ? String(actor.id) : null;
  const stamp = Date.now();
  const syntheticOrder =
    bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE
      ? null
      : `bypass_order:${bypassType}:${stamp}`;
  const syntheticCapture =
    bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE
      ? null
      : `bypass_cap:${bypassType}:${stamp}`;

  const ins = await dbQuery(
    `INSERT INTO bookings (
       user_id, customer_name, customer_email, barber_name, barber_id, service,
       service_duration_minutes, date, time, amount,
       total_price, service_price, deposit_amount, amount_paid, remaining_balance, balance_due,
       payment_type, payment_status, payment_provider, paypal_order_id, paypal_capture_id,
       platform_fee, total_amount, booking_status, is_paid_booking,
       platform_fee_status, barber_payout_amount, barber_fee_billed, tip_amount, total_paid,
       business_id, style_id, style_title,
       manual_bypass, bypass_payment_type, bypass_reason, bypass_created_by,
       bypass_created_by_email, bypass_created_at, appointment_notes
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6,
       $7, $8::date, $9::time, $10,
       $11, $12, 0, $13, $14, $14,
       $15, $16, $17, $18, $19,
       $20, $21, $22, $23,
       $24, $25, false, $26, $27,
       $28, $29, $30,
       true, $31, $32, $33::uuid,
       $34, NOW(), $35
     )
     RETURNING id, booking_status, payment_status, total_price, total_amount, platform_fee,
               is_paid_booking, customer_name, customer_email, barber_name, barber_id,
               service, date::text AS date, to_char(time,'HH24:MI') AS time,
               manual_bypass, bypass_payment_type, bypass_reason, bypass_created_by_email,
               bypass_created_at, appointment_notes, created_at, user_id, business_id`,
    [
      client.userId,
      client.name,
      client.email,
      barberName,
      insertBarberId,
      service.title,
      service.durationMinutes,
      dateStr,
      timeStr,
      haircutPrice,
      haircutPrice,
      haircutPrice,
      amountPaid,
      remaining,
      paymentType,
      paymentStatus,
      paymentProvider,
      syntheticOrder,
      syntheticCapture,
      platformFee,
      total,
      bookingStatus,
      isPaidBooking,
      bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE ? "pending" : "waived",
      barberPayout,
      tipAmount,
      bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE ? 0 : amountPaid,
      businessId != null && Number.isFinite(Number(businessId)) ? Number(businessId) : null,
      service.id,
      service.title,
      bypassType,
      reason,
      actorId,
      actorEmail,
      notes,
    ],
  );

  const booking = ins.rows?.[0];
  if (!booking?.id) {
    return { ok: false, status: 500, message: "Could not create booking" };
  }

  try {
    const { recordStatusChange } = await import("./bookingStatusEngine.js");
    await recordStatusChange({
      bookingId: booking.id,
      previousStatus: null,
      newStatus: bookingStatus,
      actor: { userId: actorId, role: "super_admin", email: actorEmail },
      note: `Manual bypass (${bypassType})${reason ? `: ${reason}` : ""}`,
    });
  } catch {
    /* non-fatal */
  }

  await logAdminActivity({
    eventType: "manual_bypass_created",
    adminUserId: actorId,
    adminEmail: actorEmail,
    userEmail: client.email,
    userName: client.name,
    detail: `Bypass ${bypassType} booking ${booking.id}`,
    metadata: {
      bookingId: booking.id,
      barberId: barberKey,
      barberName,
      paymentType: bypassType,
      reason,
      date: dateStr,
      time: timeStr,
    },
  }).catch(() => {});

  let paypal = null;
  if (bypassType === BYPASS_PAYMENT_TYPES.PAID_ONLINE && typeof startPaidOnlineCheckout === "function") {
    try {
      paypal = await startPaidOnlineCheckout(booking);
    } catch (e) {
      console.warn("[manual-bypass] paid_online checkout start failed:", e?.message || e);
      return {
        ok: true,
        booking,
        paypal: { ok: false, message: e?.message || "PayPal checkout could not be started" },
        warning: "Booking created as pending_payment; start checkout from admin if needed.",
      };
    }
  }

  const shouldEmail =
    bypassType !== BYPASS_PAYMENT_TYPES.STAFF_TRAINING
    || body?.sendEmail === true;
  if (shouldEmail && typeof sendBookingEmail === "function" && client.email) {
    try {
      await sendBookingEmail({
        name: client.name,
        email: client.email,
        barberName,
        date: dateStr,
        time: timeStr,
        service: service.title,
        totalPrice: haircutPrice,
        totalAmount: total,
        platformFee,
        tipAmount,
        paymentStatus,
        bookingStatus,
        paymentType: bypassType,
        appointmentNotes: notes,
      });
    } catch (e) {
      console.warn("[manual-bypass] confirmation email failed:", e?.message || e);
    }
  }

  try {
    const pushNotifier = await import("./pushNotifier.js");
    void pushNotifier
      .sendBookingPush({
        dbQuery,
        booking: {
          id: booking.id,
          user_id: client.userId,
          customer_email: client.email,
          customer_name: client.name,
          barber_id: barberKey,
          barber_name: barberName,
          business_id: businessId,
          service: service.title,
          date: dateStr,
          time: timeStr,
        },
        kind: "booking_confirmation",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: booking.id, bypass: bypassType },
      })
      .catch(() => {});
  } catch {
    /* optional */
  }

  void import("./hubspotService.js")
    .then((m) =>
      m.enqueueDealSyncById(booking.id, {
        reason: "manual_bypass_created",
        dealExtras: { ifcdc_confirmation_sent: shouldEmail },
      }),
    )
    .catch(() => {});

  return { ok: true, booking, paypal };
}

/**
 * Convert complimentary or pay_at_shop → paid (online settled or cash received).
 */
export async function convertBypassBookingToPaid({
  bookingId,
  actor,
  mode = "mark_paid", // mark_paid | start_online
  note = null,
  startPaidOnlineCheckout = null,
} = {}) {
  await ensureManualBypassBookingColumns(dbQuery);
  const id = text(bookingId);
  if (!id) return { ok: false, status: 400, message: "bookingId required" };

  const found = await dbQuery(
    `SELECT * FROM bookings WHERE id = $1::uuid AND coalesce(manual_bypass,false) = true AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  const row = found.rows?.[0];
  if (!row) return { ok: false, status: 404, message: "Bypass booking not found" };

  const bypassType = text(row.bypass_payment_type).toLowerCase();
  if (
    bypassType !== BYPASS_PAYMENT_TYPES.COMPLIMENTARY
    && bypassType !== BYPASS_PAYMENT_TYPES.PAY_AT_SHOP
  ) {
    return {
      ok: false,
      status: 409,
      message: "Only Complimentary or Pay at Shop bookings can be converted to paid.",
    };
  }

  if (mode === "start_online" && typeof startPaidOnlineCheckout === "function") {
    const platformFee = round2(BARBER_PLATFORM_FEE_USD);
    const haircut = round2(row.total_price || row.service_price || row.amount || 0);
    const tip = round2(row.tip_amount || 0);
    const total = round2(haircut + platformFee + tip);
    await dbQuery(
      `UPDATE bookings SET
         payment_status = 'unpaid',
         booking_status = 'pending_payment',
         payment_provider = 'paypal',
         platform_fee = $2,
         total_amount = $3,
         remaining_balance = $3,
         balance_due = $3,
         platform_fee_status = 'pending',
         is_paid_booking = false,
         bypass_payment_type = 'paid_online'
       WHERE id = $1::uuid`,
      [id, platformFee, total],
    );
    const refreshed = (await dbQuery(`SELECT * FROM bookings WHERE id = $1::uuid`, [id])).rows[0];
    const paypal = await startPaidOnlineCheckout(refreshed);
    return { ok: true, booking: refreshed, paypal };
  }

  // mark_paid — cash / received at shop
  const haircut = round2(row.total_price || row.service_price || row.amount || 0);
  const tip = round2(row.tip_amount || 0);
  const totalPaid = round2(haircut + tip);
  const upd = await dbQuery(
    `UPDATE bookings SET
       payment_status = $2,
       is_paid_booking = true,
       amount_paid = $3,
       total_paid = $4,
       remaining_balance = 0,
       balance_due = 0,
       platform_fee = 0,
       platform_fee_status = 'waived',
       booking_status = CASE
         WHEN lower(coalesce(booking_status,'')) = 'pending_payment' THEN 'confirmed'
         ELSE booking_status
       END
     WHERE id = $1::uuid
     RETURNING id, booking_status, payment_status, is_paid_booking, total_paid, bypass_payment_type`,
    [id, PAYMENT_STATUS.PAID_IN_FULL || "paid_in_full", haircut, totalPaid],
  );

  await logAdminActivity({
    eventType: "manual_bypass_converted_paid",
    adminUserId: actor?.id || null,
    adminEmail: actor?.email || null,
    userEmail: row.customer_email,
    detail: `Converted bypass ${bypassType} → paid`,
    metadata: { bookingId: id, note: text(note) || null, from: bypassType },
  }).catch(() => {});

  return { ok: true, booking: upd.rows[0] };
}

export async function cancelManualBypassBooking({ bookingId, actor, note = null } = {}) {
  await ensureManualBypassBookingColumns(dbQuery);
  const id = text(bookingId);
  const found = await dbQuery(
    `SELECT id, booking_status, customer_email, bypass_payment_type
     FROM bookings
     WHERE id = $1::uuid AND coalesce(manual_bypass,false) = true AND deleted_at IS NULL
     LIMIT 1`,
    [id],
  );
  const row = found.rows?.[0];
  if (!row) return { ok: false, status: 404, message: "Bypass booking not found" };

  const upd = await dbQuery(
    `UPDATE bookings SET
       booking_status = 'cancelled',
       cancelled_at = COALESCE(cancelled_at, NOW()),
       cancelled_by = COALESCE(cancelled_by, $2),
       is_paid_booking = false
     WHERE id = $1::uuid
     RETURNING id, booking_status, cancelled_at`,
    [id, text(actor?.email) || "super_admin"],
  );

  await logAdminActivity({
    eventType: "manual_bypass_cancelled",
    adminUserId: actor?.id || null,
    adminEmail: actor?.email || null,
    userEmail: row.customer_email,
    detail: `Cancelled bypass booking`,
    metadata: { bookingId: id, note: text(note) || null, paymentType: row.bypass_payment_type },
  }).catch(() => {});

  return { ok: true, booking: upd.rows[0] };
}
