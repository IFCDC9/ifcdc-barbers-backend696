/**
 * Booking lifecycle SMS (gated by SMS_NOTIFICATIONS_ENABLED).
 * Failures never throw — caller booking/payment flows stay intact.
 */
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
const { normalizeToE164 } = require("./smsPhone.cjs");

function shortRef(bookingId) {
  const id = String(bookingId || "").replace(/-/g, "");
  return id ? id.slice(0, 8).toUpperCase() : "N/A";
}

function formatWhen(date, time) {
  const d = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 5);
  return [d, t].filter(Boolean).join(" ");
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
    const to = resolvePhone(booking) || opts.to || null;
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
  notifyBookingSms,
  resolvePhone,
};
