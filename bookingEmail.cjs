/**
 * Booking email — Resend only via `emailResend.cjs`. Runs after booking is saved (server-side).
 */
const path = require("node:path");
const {
  isResendConfigured,
  getResend,
  getMailFrom,
  sanitizeEnvLine,
  getResendApiKey,
  sendEmail,
  sendResendWithRetry,
} = require("./emailResend.cjs");
const {
  PAYMENT_STATUS,
  paymentStatusForEmailFromRow,
  shouldSendPaidConfirmationEmail,
  round2,
} = require("./bookingPaymentSettlement.cjs");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatResendError(err) {
  if (err == null) {
    return "";
  }
  if (typeof err === "string") {
    return err;
  }
  const parts = [];
  if (typeof err.error === "string" && err.error) {
    parts.push(err.error);
  }
  if (typeof err.message === "string" && err.message) {
    parts.push(err.message);
  } else if (Array.isArray(err.message)) {
    for (const item of err.message) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item.message === "string") {
        parts.push(item.message);
      }
    }
  }
  if (typeof err.name === "string" && err.name) {
    parts.push(`[${err.name}]`);
  }
  if (typeof err.statusCode === "number") {
    parts.push(`HTTP ${err.statusCode}`);
  }
  if (parts.length) {
    return parts.join(" ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Map Resend API errors to stable warning codes for the client. */
function classifyResendFailure(err) {
  const status = typeof err?.statusCode === "number" ? err.statusCode : null;
  const msg = formatResendError(err).toLowerCase();
  if (status === 401 || status === 403) {
    return "resend_auth_failed";
  }
  /* Resend often returns HTTP 400 (not 401) for a bad API key. */
  if (status === 400 && msg.includes("api key")) {
    return "resend_auth_failed";
  }
  if (
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    (msg.includes("api key") && (msg.includes("invalid") || msg.includes("missing"))) ||
    msg.includes("http 401") ||
    msg.includes("http 403")
  ) {
    return "resend_auth_failed";
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return "resend_rate_limited";
  }
  if (
    msg.includes("only send") ||
    msg.includes("testing email") ||
    msg.includes("verify a domain") ||
    msg.includes("domain is not verified") ||
    msg.includes("not verified") ||
    msg.includes("verify your domain") ||
    msg.includes("send emails to other recipients") ||
    msg.includes("own email address") ||
    msg.includes("sandbox")
  ) {
    return "resend_verify_domain";
  }
  if (
    msg.includes("invalid `from`") ||
    msg.includes("invalid from") ||
    (msg.includes("from") && (msg.includes("invalid") || msg.includes("not allowed") || msg.includes("format")))
  ) {
    return "resend_invalid_from";
  }
  return "resend_failed";
}

function htmlToPlainText(html) {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Customer-facing labels only (admin copies stay English). */
function bookingEmailLabels(language) {
  const es = String(language || "")
    .trim()
    .toLowerCase()
    .startsWith("es");
  if (es) {
    return {
      subjectFull: "Confirmación de reserva — IFCDC Barbers",
      subjectDeposit: "Confirmación de reserva (depósito) — IFCDC Barbers",
      h2: "Reserva confirmada",
      lblName: "Nombre",
      lblBarber: "Barbero",
      lblService: "Servicio",
      lblServicePrice: "Precio del servicio",
      lblServiceDuration: "Duración",
      lblDate: "Fecha",
      lblTime: "Hora",
      lblDepositPaid: "Depósito pagado",
      lblServiceTotal: "Total del servicio",
      lblRemaining: "Saldo pendiente (normalmente el día de la cita)",
      lblAmountPaid: "Monto pagado",
      lblPaidInFull: "(pagado completo)",
      lblTip: "Propina",
      lblTotalCharged: "Total cobrado (PayPal)",
      lblPayRef: "Referencia de pago",
    };
  }
  return {
    subjectFull: "Booking Confirmation - IFCDC Barbers",
    subjectDeposit: "Booking confirmed (deposit) — IFCDC Barbers",
    h2: "Booking Confirmed",
    lblName: "Name",
    lblBarber: "Barber",
    lblService: "Service",
    lblServicePrice: "Service price",
    lblServiceDuration: "Duration",
    lblDate: "Date",
    lblTime: "Time",
    lblDepositPaid: "Deposit paid",
    lblServiceTotal: "Service total",
    lblRemaining: "Remaining balance (typically due at your appointment)",
    lblAmountPaid: "Amount paid",
    lblPaidInFull: "(paid in full)",
    lblTip: "Tip",
    lblTotalCharged: "Total charged (PayPal)",
    lblPayRef: "Payment reference",
  };
}

function isEmailConfigured() {
  return isResendConfigured();
}

function logResendStatus() {
  if (!isResendConfigured()) {
    console.warn(
      "[email] RESEND_API_KEY missing or invalid — set in backend/.env (" + path.join(__dirname, "backend", ".env") + ")"
    );
    return;
  }
  const rk = getResendApiKey();
  if (rk && rk.startsWith("re_")) {
    console.log("[email] Resend API key loaded (length " + rk.length + " chars). If sends return 401, create a new key at resend.com/api-keys.");
  }
  if (rk && !rk.startsWith("re_")) {
    console.warn(
      '[email] RESEND_API_KEY should start with "re_" (see https://resend.com/api-keys). Wrong format causes resend_auth_failed / 401.'
    );
  }
  if (!sanitizeEnvLine(process.env.MAIL_FROM)) {
    console.warn(
      '[email] MAIL_FROM not set — set MAIL_FROM=IFCDC Barbers <notifications@ifcdcbarbersapp.com> in backend/.env (verified domain).'
    );
  }
}

/**
 * Build email subject + bodies from verified payment_status only (never payment_type / checkout labels).
 * @param {string} paymentStatus
 * @param {object} p
 */
function buildPaymentEmailContent(paymentStatus, p) {
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00");
  const servicePrice = round2(p.servicePrice ?? p.totalPrice ?? 0);
  const platformFee = round2(p.platformFee ?? 0.99);
  const tip = round2(p.tipAmount ?? 0);
  const chargedToday = round2(p.amountCharged ?? p.amountPaid ?? p.totalPaid ?? 0);
  const balanceDue = round2(p.balanceDue ?? p.remainingBalance ?? 0);
  const captureId = p.paymentId || p.captureId || null;
  const status = String(paymentStatus || PAYMENT_STATUS.UNPAID).toLowerCase();

  const safeName = escapeHtml(p.name || "Guest");
  const safeService = escapeHtml(p.service || "TBD");
  const safeDate = escapeHtml(p.date || "TBD");
  const safeTime = escapeHtml(p.time || "TBD");
  const safeBarber = p.barberName ? escapeHtml(p.barberName) : "";
  const payRefLine = captureId && shouldSendPaidConfirmationEmail(status)
    ? `<p><strong>PayPal ref:</strong> ${escapeHtml(String(captureId))}</p>`
    : "";

  if (
    status === PAYMENT_STATUS.PAID_IN_FULL ||
    status === PAYMENT_STATUS.PAID_FULL ||
    status === PAYMENT_STATUS.PAID
  ) {
    const subject = "[IFCDC] New booking — Paid in Full";
    const html = `
<h2>Booking Confirmed</h2>
<p>Name: ${safeName}</p>
${safeBarber ? `<p>Barber: ${safeBarber}</p>` : ""}
<p>Service: ${safeService}</p>
<p>Date: ${safeDate}</p>
<p>Time: ${safeTime}</p>
<p><strong>Payment status:</strong> PAID IN FULL</p>
<p>Service price: $${fmt(servicePrice)}</p>
<p>Platform fee: $${fmt(platformFee)}</p>
<p>Tip: $${fmt(tip)}</p>
<p>Charged today: $${fmt(chargedToday)}</p>
<p>Balance due: $0.00</p>
${payRefLine}
    `.trim();
    return { subject, html, plain: htmlToPlainText(html), template: "paid_full" };
  }

  const subject = "[IFCDC] Booking pending — Payment Not Completed";
  const html = `
<h2>Booking Pending</h2>
<p>Name: ${safeName}</p>
${safeBarber ? `<p>Barber: ${safeBarber}</p>` : ""}
<p>Service: ${safeService}</p>
<p>Date: ${safeDate}</p>
<p>Time: ${safeTime}</p>
<p><strong>Payment status:</strong> PAYMENT NOT COMPLETED</p>
<p>Service price: $${fmt(servicePrice)}</p>
<p>Platform fee: $${fmt(platformFee)}</p>
<p>Do not treat this appointment as paid in full until PayPal capture is verified.</p>
  `.trim();
  return { subject, html, plain: htmlToPlainText(html), template: "pending" };
}

/**
 * Primary booking confirmation — Resend only. **Throws** if the customer email fails after retries.
 * Uses payment_status + capture amount as source of truth (never payment_type alone).
 *
 * @param {object} p
 */
async function sendBookingEmail({
  name,
  email,
  service,
  servicePrice,
  serviceDuration,
  date,
  time,
  paymentId,
  captureId,
  barberName,
  totalPrice,
  depositAmount,
  amountPaid,
  amountCharged,
  remainingBalance,
  balanceDue,
  paymentType,
  paymentStatus,
  tipAmount,
  totalPaid,
  platformFee,
  language,
  bookingRow,
} = {}) {
  const resend = getResend();
  if (!resend) {
    throw new Error("RESEND_API_KEY missing or invalid (must start with re_)");
  }

  const toAddr = String(email ?? "").trim();
  if (!toAddr) {
    throw new Error("Customer email is required");
  }

  const from = getMailFrom();
  if (!from) {
    throw new Error(
      'MAIL_FROM is not set. Set MAIL_FROM=IFCDC Barbers <notifications@ifcdcbarbersapp.com> in backend/.env'
    );
  }
  const resolvedStatus = paymentStatus
    ? String(paymentStatus).toLowerCase()
    : bookingRow
      ? paymentStatusForEmailFromRow(bookingRow)
      : PAYMENT_STATUS.UNPAID;

  const emailContent = buildPaymentEmailContent(resolvedStatus, {
    name,
    service,
    date,
    time,
    barberName,
    servicePrice: servicePrice ?? totalPrice,
    totalPrice,
    platformFee,
    tipAmount,
    amountCharged: amountCharged ?? amountPaid ?? totalPaid,
    amountPaid,
    balanceDue: balanceDue ?? remainingBalance,
    remainingBalance,
    paymentId: paymentId || captureId,
    captureId: captureId || paymentId,
  });

  const customerResult = await sendEmail({
    to: toAddr,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.plain,
    label: `booking-confirmation-${emailContent.template}`,
  });
  if (customerResult.error) {
    throw new Error(customerResult.error.message || "Booking email send failed");
  }

  const adminEmail = String(process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org").trim();
  let adminResult = null;
  if (adminEmail) {
    const adminPlain = emailContent.plain;
    try {
      adminResult = await sendResendWithRetry(
        resend,
        {
          from,
          to: adminEmail,
          subject: emailContent.subject,
          html: emailContent.html,
          text: adminPlain,
        },
        "booking-admin-notification"
      );
    } catch (adminErr) {
      console.error(
        "ADMIN EMAIL FAILED (after retry):",
        adminErr instanceof Error ? adminErr.stack : JSON.stringify(adminErr, null, 2)
      );
    }
  }

  return {
    success: true,
    customer: customerResult,
    admin: adminResult,
    messageId: customerResult.data?.id,
  };
}

/**
 * Legacy shape (`to`, `barberName`) — delegates to {@link sendBookingEmail}.
 */
async function sendBookingConfirmationEmail({
  to,
  name,
  barberName,
  date,
  time,
  paymentId,
  totalPrice,
  depositAmount,
  amountPaid,
  remainingBalance,
  paymentType,
  tipAmount,
  totalPaid,
  language,
} = {}) {
  await sendBookingEmail({
    name,
    email: to,
    service: barberName || "Your barber",
    barberName,
    date,
    time,
    paymentId,
    totalPrice,
    depositAmount,
    amountPaid,
    remainingBalance,
    paymentType,
    tipAmount,
    totalPaid,
    language,
  });
  return { ok: true };
}

function trimmedDateTime(date, time) {
  return `${date || ""} ${time || ""}`.trim();
}

/**
 * AURA Voice booking email — intentionally minimal and independent from payment emails.
 * Sends to the client email if present, and always to service@ifcdc.org.
 *
 * @param {{ name?: string, email?: string, date?: string, time?: string, barberName?: string, barber?: string }} booking
 */
async function sendAuraVoiceBookingEmail(booking = {}) {
  const resend = getResend();
  if (!resend) {
    throw new Error("RESEND_API_KEY missing or invalid (must start with re_)");
  }

  const clientEmail = String(booking.email || "").trim() || "service@ifcdc.org";
  const recipients = Array.from(new Set([clientEmail, "service@ifcdc.org"]));
  console.log("EMAIL FINAL RECIPIENTS:", recipients);

  const es = String(booking.language || "")
    .trim()
    .toLowerCase()
    .startsWith("es");
  const safeName = escapeHtml(String(booking.name || "Guest"));
  const safeTime = escapeHtml(trimmedDateTime(booking.date, booking.time) || String(booking.time || "TBD"));
  const safeBarber = escapeHtml(String(booking.barberName || booking.barber || "TBD"));

  const h2 = es ? "Cita confirmada" : "Appointment Confirmed";
  const lnName = es ? "Nombre" : "Name";
  const lnTime = es ? "Hora" : "Time";
  const lnBarber = es ? "Barbero" : "Barber";
  const subject = es ? "Cita confirmada — IFCDC Barbers" : "Booking Confirmed — IFCDC Barbers";

  const html = `
    <h2>${h2}</h2>
    <p>${lnName}: ${safeName}</p>
    <p>${lnTime}: ${safeTime}</p>
    <p>${lnBarber}: ${safeBarber}</p>
  `.trim();

  await resend.emails.send({
    from: "IFCDC Barbers <notifications@ifcdcbarbersapp.com>",
    to: recipients,
    subject,
    html,
    text: htmlToPlainText(html),
  });

  return { ok: true };
}

/**
 * Refund confirmation — customer + service@ifcdc.org (best-effort; does not throw).
 * @param {object} p
 */
async function sendBookingRefundEmail({
  name,
  email,
  service,
  date,
  time,
  barberName,
  refundAmount,
  refundId,
  reason,
  paymentStatus,
} = {}) {
  const to = String(email || "").trim();
  if (!to || /@ifcdc\.local$/i.test(to) || /^pending\+/i.test(to)) {
    return { success: false, skipped: true, reason: "no_customer_email" };
  }
  if (!isResendConfigured()) {
    return { success: false, skipped: true, reason: "resend_not_configured" };
  }

  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00");
  const safeName = escapeHtml(name || "Guest");
  const safeService = escapeHtml(service || "Appointment");
  const safeDate = escapeHtml(date || "TBD");
  const safeTime = escapeHtml(time || "TBD");
  const safeBarber = barberName ? escapeHtml(barberName) : "";
  const statusLabel = String(paymentStatus || "refunded").replace(/_/g, " ").toUpperCase();
  const subject = `[IFCDC] Refund processed — $${fmt(refundAmount)}`;
  const html = `
<h2>Refund confirmation</h2>
<p>Name: ${safeName}</p>
${safeBarber ? `<p>Barber: ${safeBarber}</p>` : ""}
<p>Service: ${safeService}</p>
<p>Date: ${safeDate}</p>
<p>Time: ${safeTime}</p>
<p><strong>Status:</strong> ${escapeHtml(statusLabel)}</p>
<p>Refund amount: $${fmt(refundAmount)}</p>
${refundId ? `<p>PayPal refund ref: ${escapeHtml(String(refundId))}</p>` : ""}
${reason ? `<p>Reason: ${escapeHtml(String(reason))}</p>` : ""}
<p>Funds typically return to your PayPal or card within 3–10 business days.</p>
  `.trim();

  const adminHtml = `
<h2>Admin — booking refund</h2>
<p>Customer: ${safeName} (${escapeHtml(to)})</p>
<p>Service: ${safeService} · ${safeDate} ${safeTime}</p>
<p>Refund: $${fmt(refundAmount)} · ${escapeHtml(statusLabel)}</p>
${refundId ? `<p>PayPal refund: ${escapeHtml(String(refundId))}</p>` : ""}
  `.trim();

  try {
    const customerResult = await sendResendWithRetry({
      to,
      subject,
      html,
      text: htmlToPlainText(html),
    });
    let adminResult = { ok: true };
    try {
      adminResult = await sendEmail({
        to: "service@ifcdc.org",
        subject: `[IFCDC Admin] Refund — ${safeName}`,
        html: adminHtml,
        text: htmlToPlainText(adminHtml),
      });
    } catch (adminErr) {
      console.warn("[email] refund admin copy failed:", adminErr?.message || adminErr);
    }
    return { success: true, customer: customerResult, admin: adminResult };
  } catch (e) {
    console.warn("[email] sendBookingRefundEmail failed:", formatResendError(e));
    return { success: false, error: formatResendError(e) };
  }
}

module.exports = {
  sendBookingEmail,
  sendBookingConfirmationEmail,
  sendAuraVoiceBookingEmail,
  sendBookingRefundEmail,
  isEmailConfigured,
  logResendStatus,
};
