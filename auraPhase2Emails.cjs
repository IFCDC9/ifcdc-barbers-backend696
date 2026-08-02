/**
 * AURA Phase 2 customer/barber/admin email helpers.
 * Always uses existing Resend pipeline + current MAIL_FROM (no sender domain switch).
 */
const { sendEmail, getMailFrom } = require("./emailResend.cjs");
const { auraReceptionistIdentity } = require("./auraPhase2Flags.cjs");

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

function shopLocation() {
  return (
    String(process.env.BUSINESS_ADDRESS || process.env.SHOP_ADDRESS || "").trim() ||
    "IFCDC Barbers (see confirmation / app for address)"
  );
}

function auraFooterHtml() {
  const who = escapeHtml(auraReceptionistIdentity());
  return `<p style="margin-top:24px;font-size:12px;color:#666;">Sent by ${who}.</p>`;
}

function bookingFields(p = {}) {
  return {
    name: String(p.customerName || p.name || "Guest").trim(),
    email: String(p.customerEmail || p.email || "").trim(),
    barber: String(p.barberName || p.barber || "your barber").trim(),
    service: String(p.service || "Appointment").trim(),
    date: String(p.date || "TBD").trim(),
    time: String(p.time || "TBD").trim(),
    location: String(p.location || shopLocation()).trim(),
    price: money(p.price ?? p.totalPrice ?? p.amountPaid ?? p.totalPaid),
    bookingId: String(p.bookingId || p.id || "").trim(),
  };
}

function buildBookingDetailsHtml(f) {
  return `
<p>Customer: <strong>${escapeHtml(f.name)}</strong></p>
<p>Barber: <strong>${escapeHtml(f.barber)}</strong></p>
<p>Service: <strong>${escapeHtml(f.service)}</strong></p>
<p>Date: <strong>${escapeHtml(f.date)}</strong></p>
<p>Time: <strong>${escapeHtml(f.time)}</strong></p>
<p>Location: <strong>${escapeHtml(f.location)}</strong></p>
<p>Price: <strong>$${escapeHtml(f.price)}</strong></p>
${f.bookingId ? `<p>Booking reference: <strong>${escapeHtml(f.bookingId)}</strong></p>` : ""}
`.trim();
}

async function sendAuraTemplatedEmail({ to, subject, heading, bodyHtml, label }) {
  const from = getMailFrom();
  if (!from) return { ok: false, error: "MAIL_FROM_missing" };
  const dest = String(to || "").trim();
  if (!dest || !dest.includes("@")) return { ok: false, error: "invalid_to" };
  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#111;">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;color:#b8860b;font-weight:700;">IFCDC BARBERS</p>
  <h2 style="margin:0 0 16px;">${escapeHtml(heading)}</h2>
  ${bodyHtml}
  ${auraFooterHtml()}
</div>`.trim();
  try {
    const out = await sendEmail({
      to: dest,
      subject,
      html,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      label: label || "aura-phase2",
    });
    if (out?.error) return { ok: false, error: out.error.message || "send_failed" };
    return { ok: true, id: out?.id || null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendAuraReminderEmail(payload, windowLabel) {
  const f = bookingFields(payload);
  const heading =
    windowLabel === "24h"
      ? "Appointment reminder — 24 hours"
      : windowLabel === "2h"
        ? "Appointment reminder — 2 hours"
        : windowLabel === "30m"
          ? "Appointment reminder — 30 minutes"
          : "Appointment reminder";
  return sendAuraTemplatedEmail({
    to: f.email,
    subject: `${heading} — IFCDC Barbers`,
    heading,
    bodyHtml: `<p>Hi ${escapeHtml(f.name)},</p><p>This is a reminder from ${escapeHtml(auraReceptionistIdentity())} about your upcoming appointment.</p>${buildBookingDetailsHtml(f)}`,
    label: `aura-reminder-${windowLabel}`,
  });
}

async function sendAuraCancelEmail(payload) {
  const f = bookingFields(payload);
  return sendAuraTemplatedEmail({
    to: f.email,
    subject: "Appointment cancelled — IFCDC Barbers",
    heading: "Appointment cancelled",
    bodyHtml: `<p>Hi ${escapeHtml(f.name)},</p><p>Your appointment has been cancelled.</p>${buildBookingDetailsHtml(f)}`,
    label: "aura-cancel-customer",
  });
}

async function sendAuraRescheduleEmail(payload) {
  const f = bookingFields(payload);
  const fromLabel = String(payload.fromLabel || "").trim();
  return sendAuraTemplatedEmail({
    to: f.email,
    subject: "Appointment rescheduled — IFCDC Barbers",
    heading: "Appointment rescheduled",
    bodyHtml: `<p>Hi ${escapeHtml(f.name)},</p><p>Your appointment has been rescheduled${fromLabel ? ` from <strong>${escapeHtml(fromLabel)}</strong>` : ""}.</p>${buildBookingDetailsHtml(f)}`,
    label: "aura-reschedule-customer",
  });
}

async function sendAuraBarberEventEmail(payload, eventType) {
  const f = bookingFields(payload);
  const barberEmail = String(payload.barberEmail || "").trim();
  if (!barberEmail) return { ok: false, error: "no_barber_email" };
  const titles = {
    created: "New appointment assigned",
    cancelled: "Appointment cancelled",
    rescheduled: "Appointment rescheduled",
  };
  const heading = titles[eventType] || "Appointment update";
  return sendAuraTemplatedEmail({
    to: barberEmail,
    subject: `[IFCDC] ${heading}`,
    heading,
    bodyHtml: `<p>${escapeHtml(auraReceptionistIdentity())} notifying you of a booking update.</p>${buildBookingDetailsHtml(f)}`,
    label: `aura-barber-${eventType}`,
  });
}

async function sendAuraAdminFailureAlert(payload = {}) {
  const adminTo = String(
    process.env.BOOKING_ADMIN_EMAIL || process.env.AURA_DAILY_REPORT_TO || "service@ifcdc.org",
  ).trim();
  const kind = String(payload.kind || "failure").slice(0, 80);
  const detail = payload.detail || payload;
  return sendAuraTemplatedEmail({
    to: adminTo,
    subject: `[IFCDC AURA] Super Admin attention — ${kind}`,
    heading: "Action required",
    bodyHtml: `<p>${escapeHtml(auraReceptionistIdentity())} detected a failure that needs Super Admin review.</p>
<p><strong>Kind:</strong> ${escapeHtml(kind)}</p>
<pre style="font-size:12px;background:#f4f4f4;padding:12px;">${escapeHtml(JSON.stringify(detail, null, 2).slice(0, 4000))}</pre>`,
    label: "aura-admin-alert",
  });
}

async function sendAuraReviewFollowupEmail(payload = {}) {
  const f = bookingFields(payload);
  const web = String(process.env.PUBLIC_WEB_URL || "https://ifcdcbarbersapp.com").replace(/\/$/, "");
  const rateUrl = String(payload.rateMeUrl || `${web}/profile`).trim();
  const rewards = payload.rewardsProgress
    ? `<p>Rewards progress: <strong>${escapeHtml(String(payload.rewardsProgress))}</strong></p>`
    : `<p>Visit Profile → Rewards to see your progress.</p>`;
  return sendAuraTemplatedEmail({
    to: f.email,
    subject: "How was your visit? — IFCDC Barbers",
    heading: "Thanks for visiting IFCDC Barbers",
    bodyHtml: `<p>Hi ${escapeHtml(f.name)},</p>
<p>We hope you loved your visit with <strong>${escapeHtml(f.barber)}</strong>. When you have a moment, please rate your experience.</p>
<p><a href="${escapeHtml(rateUrl)}">Rate Me</a></p>
${rewards}
${buildBookingDetailsHtml(f)}`,
    label: "aura-review-followup",
  });
}

module.exports = {
  escapeHtml,
  bookingFields,
  shopLocation,
  sendAuraTemplatedEmail,
  sendAuraReminderEmail,
  sendAuraCancelEmail,
  sendAuraRescheduleEmail,
  sendAuraBarberEventEmail,
  sendAuraAdminFailureAlert,
  sendAuraReviewFollowupEmail,
};
