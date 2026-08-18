/**
 * Booking lifecycle SMS (gated by SMS_NOTIFICATIONS_ENABLED).
 * Failures never throw — caller booking/payment flows stay intact.
 */
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");

function shortRef(bookingId) {
  const id = String(bookingId || "").replace(/-/g, "");
  return id ? id.slice(0, 8).toUpperCase() : "N/A";
}

function formatWhen(date, time) {
  const d = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 5);
  return [d, t].filter(Boolean).join(" ");
}

function formatAppointmentWhen(date, time) {
  const d = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 8);
  let datePart = d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    try {
      const dt = new Date(`${d}T12:00:00`);
      datePart = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      datePart = d;
    }
  }
  let timePart = t.slice(0, 5);
  const hm = t.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const hh = Number(hm[1]);
    const mm = hm[2];
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh + 11) % 12) + 1;
    timePart = `${h12}:${mm} ${ampm}`;
  }
  if (datePart && timePart) return `${datePart} at ${timePart}`;
  return [datePart, timePart].filter(Boolean).join(" ");
}

function formatUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

/**
 * Paid + captured confirmation SMS. Example:
 * IFCDC Barbers · Ref ABC123: Payment received — $35.00. Your Haircut with IFCDC Barbers is confirmed for Aug 20 at 2:00 PM. Thank you for booking.
 */
function buildPaidConfirmationSmsBody(booking = {}, extra = {}) {
  const customer = String(
    booking.customer_name || booking.customerName || booking.name || "",
  ).trim();
  const barber = String(
    booking.barber_name || booking.barberName || extra.barberName || "IFCDC Barbers",
  ).trim();
  const shop = String(
    extra.shopName || booking.shop_name || booking.business_name || booking.location || "",
  ).trim();
  const withWho = shop && shop.toLowerCase() !== barber.toLowerCase() ? `${barber} at ${shop}` : barber;
  const service = String(booking.service || booking.style_title || extra.service || "appointment").trim();
  const when = formatAppointmentWhen(booking.date, booking.time);
  const ref = shortRef(booking.id || booking.bookingId);
  const amount = formatUsd(
    extra.amountPaid ??
      booking.amount_paid ??
      booking.amountPaid ??
      booking.amount_charged ??
      booking.total_amount ??
      extra.capturedUsd,
  );
  const amt = amount || "paid in full";
  const thanks = customer ? ` Thank you for booking, ${customer}.` : " Thank you for booking.";
  return `IFCDC Barbers · Ref ${ref}: Payment received — ${amt}. Your ${service} with ${withWho} is confirmed for ${when}.${thanks} Support: +19895141064`;
}

function isPaidCapturedForSms(booking = {}, opts = {}) {
  const captureId = String(
    opts.captureId || booking.paypal_capture_id || booking.captureId || "",
  ).trim();
  if (!captureId) return { ok: false, reason: "no_capture" };
  const { shouldSendPaidConfirmationEmail, isBookingPaymentSettled } = require("./bookingPaymentSettlement.cjs");
  const status = opts.paymentStatus || booking.payment_status || booking.paymentStatus;
  if (opts.alreadySettled === true) return { ok: true, captureId };
  if (shouldSendPaidConfirmationEmail(status) || isBookingPaymentSettled(booking)) {
    return { ok: true, captureId };
  }
  return { ok: false, reason: "payment_not_paid", captureId };
}

/**
 * SMS only after PayPal capture is confirmed and the booking is paid.
 * Idempotent per booking so finalize + webhook retries cannot double-text.
 */
async function notifyPaidBookingConfirmationSms(dbQuery, booking = {}, opts = {}) {
  const bookingId = booking.id || booking.bookingId || null;
  const logCtx = { bookingId, captureId: opts.captureId || booking.paypal_capture_id || null };
  console.log("[sms-booking] paid confirmation CALLED", logCtx);
  try {
    const gate = isPaidCapturedForSms(booking, opts);
    if (!gate.ok) {
      console.error("[sms-booking] paid confirmation SKIPPED", { ...logCtx, reason: gate.reason });
      return { ok: true, skipped: true, reason: gate.reason };
    }

    const to = opts.to || (await resolvePhoneAsync(dbQuery, booking)) || null;
    if (!to) {
      console.error("[sms-booking] paid confirmation SKIPPED", {
        ...logCtx,
        reason: "no_phone",
        bookingPhone: Boolean(booking.phone || booking.customer_phone || booking.phone_e164),
        userId: booking.user_id || booking.userId || null,
      });
      return { ok: true, skipped: true, reason: "no_phone" };
    }

    const idempotencyKey =
      opts.idempotencyKey ||
      (bookingId ? `booking:paid_confirmation:${bookingId}` : `booking:paid_confirmation:cap:${gate.captureId}`);
    const body = buildPaidConfirmationSmsBody(booking, {
      amountPaid: opts.amountPaid,
      capturedUsd: opts.capturedUsd,
      shopName: opts.shopName,
      barberName: opts.barberName,
      service: opts.service,
    });
    const publicBase = opts.publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || "";
    const result = await sendTransactionalSms(dbQuery, {
      to,
      body,
      category: "booking_approved",
      bookingId,
      paymentRef: gate.captureId,
      userId: booking.user_id || booking.userId || null,
      idempotencyKey,
      // Transactional paid receipt: send even if the global notifications flag is off.
      // Twilio STOP still blocks at the carrier. Successful SIDs prevent webhook duplicates.
      force: opts.force !== false,
      statusCallbackUrl: publicBase
        ? `${String(publicBase).replace(/\/$/, "")}/api/sms/status`
        : null,
    });
    const maskedTo = result?.maskedTo || maskPhoneForDisplay(to);
    if (result?.ok && !result?.skipped) {
      console.log("[sms-booking] paid confirmation SENT", {
        ...logCtx,
        maskedTo,
        twilioSid: result.twilioSid || null,
        status: result.status || null,
      });
    } else if (result?.skipped) {
      const level = result.reason === "idempotent_duplicate" ? "log" : "error";
      const payload = {
        ...logCtx,
        maskedTo,
        reason: result.reason,
        twilioSid: result.twilioSid || null,
        status: result.status || null,
      };
      if (level === "log") console.log("[sms-booking] paid confirmation SKIPPED (duplicate)", payload);
      else console.error("[sms-booking] paid confirmation SKIPPED", payload);
    } else {
      console.error("[sms-booking] paid confirmation FAILED", {
        ...logCtx,
        maskedTo,
        reason: result?.reason,
        error: result?.error || null,
        errorCode: result?.errorCode || null,
        twilioSid: result?.twilioSid || null,
        status: result?.status || null,
      });
    }
    return { ...result, maskedTo, functionCalled: true };
  } catch (e) {
    console.error("[sms-booking] paid confirmation EXCEPTION", {
      ...logCtx,
      error: e?.message || String(e),
    });
    return { ok: false, reason: "exception", error: e?.message || String(e), functionCalled: true };
  }
}

function resolvePhone(booking = {}) {
  const raw =
    booking.customer_phone ||
    booking.phone ||
    booking.phone_e164 ||
    booking.customerPhone ||
    "";
  const n = normalizeToE164(raw);
  return n.ok ? n.e164 : null;
}

/** Resolve phone from booking fields, then app_users / email when dbQuery is available. */
async function resolvePhoneAsync(dbQuery, booking = {}) {
  const direct = resolvePhone(booking);
  if (direct) return direct;
  if (typeof dbQuery !== "function") return null;
  try {
    const userId = booking.user_id || booking.userId || null;
    if (userId) {
      const u = await dbQuery(
        `SELECT phone_e164, phone FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [userId],
      );
      const n = normalizeToE164(u.rows?.[0]?.phone_e164 || u.rows?.[0]?.phone || "");
      if (n.ok) return n.e164;
    }
    const email = String(booking.customer_email || booking.customerEmail || "")
      .trim()
      .toLowerCase();
    if (email.includes("@")) {
      const u = await dbQuery(
        `SELECT phone_e164, phone FROM app_users
         WHERE lower(coalesce(email,'')) = $1
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [email],
      );
      const n = normalizeToE164(u.rows?.[0]?.phone_e164 || u.rows?.[0]?.phone || "");
      if (n.ok) return n.e164;
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

/** Clear reminder markers so rescheduled appointments can receive fresh reminders. */
async function resetBookingReminderMarkers(dbQuery, bookingId) {
  if (!bookingId || typeof dbQuery !== "function") return;
  try {
    await dbQuery(
      `UPDATE bookings
       SET reminder_sent_at = NULL,
           reminder_24h_sent_at = NULL,
           reminder_2h_sent_at = NULL
       WHERE id = $1::uuid`,
      [bookingId],
    );
  } catch {
    try {
      await dbQuery(`UPDATE bookings SET reminder_sent_at = NULL WHERE id = $1::uuid`, [bookingId]);
    } catch {
      /* columns may be absent */
    }
  }
}

function buildBookingSmsBody(event, booking = {}, extra = {}) {
  const customer = String(
    booking.customer_name || booking.customerName || booking.name || "there",
  ).trim();
  const barber = String(booking.barber_name || booking.barberName || "your barber").trim();
  const service = String(booking.service || booking.style_title || "appointment").trim();
  const when = formatWhen(booking.date, booking.time);
  const location = String(
    booking.location || booking.shop_name || booking.business_name || "IFCDC Barbers",
  ).trim();
  const ref = shortRef(booking.id || booking.bookingId);
  const base = `IFCDC Barbers · Ref ${ref}`;
  switch (event) {
    case "booking_created":
      return `${base}: Hi ${customer}, we received your booking — ${service} with ${barber} on ${when} at ${location}.`;
    case "booking_approved":
      return `${base}: Hi ${customer}, your booking is confirmed — ${service} with ${barber} on ${when} at ${location}. See you then.`;
    case "booking_rescheduled":
      return `${base}: Hi ${customer}, your appointment was rescheduled — ${service} with ${barber} now ${when} at ${location}.`;
    case "booking_canceled":
      return `${base}: Hi ${customer}, your booking was canceled — ${service} with ${barber} (${when}).`;
    case "booking_completed":
      return `${base}: Hi ${customer}, thanks for visiting — ${service} with ${barber} is marked complete.`;
    case "booking_reminder":
      return `${base}: Hi ${customer}, reminder — ${service} with ${barber} on ${when} at ${location}.`;
    default:
      return `${base}: Hi ${customer}, update — ${service} with ${barber} on ${when}. ${String(extra.note || "").slice(0, 80)}`;
  }
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string }>}
 */
async function notifyBookingSms(dbQuery, event, booking, opts = {}) {
  try {
    const to = opts.to || (await resolvePhoneAsync(dbQuery, booking)) || null;
    if (!to) return { ok: true, skipped: true, reason: "no_phone" };
    const category = String(event || "booking_created");
    const body = buildBookingSmsBody(category, booking, opts);
    const bookingId = booking.id || booking.bookingId || null;
    const idempotencyKey =
      opts.idempotencyKey ||
      (bookingId ? `booking:${category}:${bookingId}:${opts.occurrence || "1"}` : null);
    const publicBase = opts.publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || "";
    return await sendTransactionalSms(dbQuery, {
      to,
      body,
      category,
      bookingId,
      userId: booking.user_id || booking.userId || null,
      idempotencyKey,
      force: Boolean(opts.force),
      statusCallbackUrl: publicBase
        ? `${String(publicBase).replace(/\/$/, "")}/api/sms/status`
        : null,
    });
  } catch (e) {
    console.warn("[sms-booking] notify failed (non-fatal):", e?.message || e);
    return { ok: false, reason: "exception", error: e?.message || String(e) };
  }
}

module.exports = {
  shortRef,
  buildBookingSmsBody,
  buildPaidConfirmationSmsBody,
  formatAppointmentWhen,
  notifyBookingSms,
  notifyPaidBookingConfirmationSms,
  resolvePhone,
  resolvePhoneAsync,
  resetBookingReminderMarkers,
};
