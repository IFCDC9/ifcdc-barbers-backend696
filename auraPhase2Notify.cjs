/**
 * AURA Phase 2 barber + admin notification helpers (flag-gated by callers).
 */
const { sendAuraBarberEventEmail, sendAuraAdminFailureAlert } = require("./auraPhase2Emails.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

async function resolveBarberEmail(dbQuery, barberId) {
  const id = String(barberId || "").trim();
  if (!id || typeof dbQuery !== "function") return null;
  try {
    const r = await dbQuery(
      `SELECT u.email AS email
       FROM barbers b
       LEFT JOIN app_users u ON u.id = b.user_id
       WHERE b.id::text = $1::text
       LIMIT 1`,
      [id],
    );
    const email = String(r.rows?.[0]?.email || "").trim();
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

async function notifyBarberBookingEvent(dbQuery, booking, eventType) {
  const barberEmail = await resolveBarberEmail(dbQuery, booking?.barber_id);
  const payload = {
    customerName: booking?.customer_name,
    customerEmail: booking?.customer_email,
    barberName: booking?.barber_name,
    barberEmail,
    service: booking?.service || booking?.style_title,
    date: booking?.date,
    time: booking?.time,
    price: booking?.total_paid ?? booking?.amount_paid ?? booking?.total_price,
    bookingId: booking?.id,
  };
  const out = await sendAuraBarberEventEmail(payload, eventType);
  await logAuraAction(dbQuery, {
    action: `barber_notify_${eventType}`,
    bookingId: booking?.id || null,
    result: out.ok ? "sent" : "failed",
    metadata: { barberEmail: barberEmail || null, error: out.error || null },
  });
  return out;
}

async function alertSuperAdminFailure(dbQuery, kind, detail) {
  const out = await sendAuraAdminFailureAlert({ kind, detail });
  await logAuraAction(dbQuery, {
    action: "admin_alert",
    result: out.ok ? "sent" : "failed",
    metadata: { kind, error: out.error || null },
  });
  return out;
}

module.exports = {
  resolveBarberEmail,
  notifyBarberBookingEvent,
  alertSuperAdminFailure,
};
