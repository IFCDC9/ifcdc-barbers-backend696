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
const { resolvePublicWebOrigin } = require("./publicSiteConfig.cjs");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publicWebFooterHtml() {
  const base = resolvePublicWebOrigin();
  const safe = escapeHtml(base);
  return `
  <p style="margin-top:24px;font-size:13px;color:#555;">
    <a href="${safe}/booking" style="color:#b8860b;">Book again on IFCDC Barbers</a><br/>
    <a href="${safe}/privacy" style="color:#666;">Privacy Policy</a>
    · <a href="${safe}/terms" style="color:#666;">Terms</a>
  </p>`.trim();
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

/** Customer-facing labels only (admin copies stay English). Falls back to English. */
function bookingEmailLabels(language) {
  const raw = String(language || "").trim().replace(/_/g, "-");
  const lower = raw.toLowerCase();
  let code = "en";
  if (lower.startsWith("es")) code = "es";
  else if (lower.startsWith("fr")) code = "fr";
  else if (lower.startsWith("ht") || lower.startsWith("cpf") || lower === "creole") code = "ht";
  else if (lower.startsWith("pt")) code = "pt";
  else if (lower.startsWith("ar")) code = "ar";
  else if (lower.startsWith("he") || lower.startsWith("iw")) code = "he";
  else if (lower.startsWith("zh")) code = "zh-CN";
  else if (lower.startsWith("ko")) code = "ko";
  else if (lower.startsWith("vi")) code = "vi";

  const EN = {
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
    thanks: "Thank you for booking with IFCDC Barbers.",
  };

  const TABLE = {
    es: {
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
      thanks: "Gracias por reservar con IFCDC Barbers.",
    },
    fr: {
      subjectFull: "Confirmation de réservation — IFCDC Barbers",
      subjectDeposit: "Réservation confirmée (acompte) — IFCDC Barbers",
      h2: "Réservation confirmée",
      lblName: "Nom",
      lblBarber: "Barbier",
      lblService: "Service",
      lblServicePrice: "Prix du service",
      lblServiceDuration: "Durée",
      lblDate: "Date",
      lblTime: "Heure",
      lblDepositPaid: "Acompte payé",
      lblServiceTotal: "Total du service",
      lblRemaining: "Solde restant (généralement dû le jour du rendez-vous)",
      lblAmountPaid: "Montant payé",
      lblPaidInFull: "(payé intégralement)",
      lblTip: "Pourboire",
      lblTotalCharged: "Total facturé (PayPal)",
      lblPayRef: "Référence de paiement",
      thanks: "Merci d’avoir réservé avec IFCDC Barbers.",
    },
    ht: {
      subjectFull: "Konfimasyon rezèvasyon — IFCDC Barbers",
      subjectDeposit: "Rezèvasyon konfime (depo) — IFCDC Barbers",
      h2: "Rezèvasyon konfime",
      lblName: "Non",
      lblBarber: "Kowafè",
      lblService: "Sèvis",
      lblServicePrice: "Pri sèvis",
      lblServiceDuration: "Dire",
      lblDate: "Dat",
      lblTime: "Lè",
      lblDepositPaid: "Depo peye",
      lblServiceTotal: "Total sèvis",
      lblRemaining: "Balans ki rete (anjeneral nan jou randevou a)",
      lblAmountPaid: "Montan peye",
      lblPaidInFull: "(peye nèt)",
      lblTip: "Tip",
      lblTotalCharged: "Total chaje (PayPal)",
      lblPayRef: "Referans peman",
      thanks: "Mèsi paske ou rezève ak IFCDC Barbers.",
    },
    pt: {
      subjectFull: "Confirmação de reserva — IFCDC Barbers",
      subjectDeposit: "Reserva confirmada (depósito) — IFCDC Barbers",
      h2: "Reserva confirmada",
      lblName: "Nome",
      lblBarber: "Barbeiro",
      lblService: "Serviço",
      lblServicePrice: "Preço do serviço",
      lblServiceDuration: "Duração",
      lblDate: "Data",
      lblTime: "Hora",
      lblDepositPaid: "Depósito pago",
      lblServiceTotal: "Total do serviço",
      lblRemaining: "Saldo restante (normalmente no dia da consulta)",
      lblAmountPaid: "Valor pago",
      lblPaidInFull: "(pago integralmente)",
      lblTip: "Gorjeta",
      lblTotalCharged: "Total cobrado (PayPal)",
      lblPayRef: "Referência de pagamento",
      thanks: "Obrigado por reservar com a IFCDC Barbers.",
    },
    ar: {
      subjectFull: "تأكيد الحجز — IFCDC Barbers",
      subjectDeposit: "تم تأكيد الحجز (عربون) — IFCDC Barbers",
      h2: "تم تأكيد الحجز",
      lblName: "الاسم",
      lblBarber: "الحلاق",
      lblService: "الخدمة",
      lblServicePrice: "سعر الخدمة",
      lblServiceDuration: "المدة",
      lblDate: "التاريخ",
      lblTime: "الوقت",
      lblDepositPaid: "العربون المدفوع",
      lblServiceTotal: "إجمالي الخدمة",
      lblRemaining: "الرصيد المتبقي (عادة في يوم الموعد)",
      lblAmountPaid: "المبلغ المدفوع",
      lblPaidInFull: "(مدفوع بالكامل)",
      lblTip: "إكرامية",
      lblTotalCharged: "الإجمالي المحصل (PayPal)",
      lblPayRef: "مرجع الدفع",
      thanks: "شكرًا لحجزك مع IFCDC Barbers.",
    },
    he: {
      subjectFull: "אישור הזמנה — IFCDC Barbers",
      subjectDeposit: "ההזמנה אושרה (מקדמה) — IFCDC Barbers",
      h2: "ההזמנה אושרה",
      lblName: "שם",
      lblBarber: "ספר",
      lblService: "שירות",
      lblServicePrice: "מחיר השירות",
      lblServiceDuration: "משך",
      lblDate: "תאריך",
      lblTime: "שעה",
      lblDepositPaid: "מקדמה ששולמה",
      lblServiceTotal: "סה״כ שירות",
      lblRemaining: "יתרה לתשלום (בדרך כלל ביום התור)",
      lblAmountPaid: "סכום ששולם",
      lblPaidInFull: "(שולם במלואו)",
      lblTip: "טיפ",
      lblTotalCharged: "סה״כ שחויב (PayPal)",
      lblPayRef: "אסמכתת תשלום",
      thanks: "תודה שהזמנתם עם IFCDC Barbers.",
    },
    "zh-CN": {
      subjectFull: "预约确认 — IFCDC Barbers",
      subjectDeposit: "预约已确认（定金）— IFCDC Barbers",
      h2: "预约已确认",
      lblName: "姓名",
      lblBarber: "理发师",
      lblService: "服务",
      lblServicePrice: "服务价格",
      lblServiceDuration: "时长",
      lblDate: "日期",
      lblTime: "时间",
      lblDepositPaid: "已付定金",
      lblServiceTotal: "服务合计",
      lblRemaining: "剩余应付（通常在预约当天支付）",
      lblAmountPaid: "已付金额",
      lblPaidInFull: "（已全额支付）",
      lblTip: "小费",
      lblTotalCharged: "PayPal 扣款总额",
      lblPayRef: "付款参考号",
      thanks: "感谢您通过 IFCDC Barbers 预约。",
    },
    ko: {
      subjectFull: "예약 확인 — IFCDC Barbers",
      subjectDeposit: "예약 확인(보증금) — IFCDC Barbers",
      h2: "예약이 확인되었습니다",
      lblName: "이름",
      lblBarber: "바버",
      lblService: "서비스",
      lblServicePrice: "서비스 가격",
      lblServiceDuration: "소요 시간",
      lblDate: "날짜",
      lblTime: "시간",
      lblDepositPaid: "보증금 결제",
      lblServiceTotal: "서비스 합계",
      lblRemaining: "잔액(보통 방문 당일 결제)",
      lblAmountPaid: "결제 금액",
      lblPaidInFull: "(전액 결제)",
      lblTip: "팁",
      lblTotalCharged: "PayPal 청구 합계",
      lblPayRef: "결제 참조",
      thanks: "IFCDC Barbers로 예약해 주셔서 감사합니다.",
    },
    vi: {
      subjectFull: "Xác nhận đặt lịch — IFCDC Barbers",
      subjectDeposit: "Đã xác nhận đặt lịch (đặt cọc) — IFCDC Barbers",
      h2: "Đã xác nhận đặt lịch",
      lblName: "Tên",
      lblBarber: "Thợ cắt tóc",
      lblService: "Dịch vụ",
      lblServicePrice: "Giá dịch vụ",
      lblServiceDuration: "Thời lượng",
      lblDate: "Ngày",
      lblTime: "Giờ",
      lblDepositPaid: "Đã thanh toán đặt cọc",
      lblServiceTotal: "Tổng dịch vụ",
      lblRemaining: "Số còn lại (thường thanh toán vào ngày hẹn)",
      lblAmountPaid: "Số tiền đã trả",
      lblPaidInFull: "(đã thanh toán đầy đủ)",
      lblTip: "Tip",
      lblTotalCharged: "Tổng đã trừ (PayPal)",
      lblPayRef: "Mã thanh toán",
      thanks: "Cảm ơn bạn đã đặt lịch với IFCDC Barbers.",
    },
  };

  return { ...EN, ...(TABLE[code] || {}) };
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

function isDeliverableCustomerEmail(addr) {
  const e = String(addr ?? "").trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  if (/@ifcdc\.local$/i.test(e)) return false;
  if (/^pending\+/i.test(e)) return false;
  return true;
}

/**
 * Customer-facing booking confirmation (IFCDC branding).
 * @param {object} p
 */
function buildCustomerConfirmationEmail(p) {
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00");
  const labels = bookingEmailLabels(p.language);
  const servicePrice = round2(p.servicePrice ?? p.totalPrice ?? 0);
  const platformFee = round2(p.platformFee ?? 0.99);
  const tip = round2(p.tipAmount ?? 0);
  const totalPaid = round2(p.amountCharged ?? p.amountPaid ?? p.totalPaid ?? 0);
  const bookingId = p.bookingId ? String(p.bookingId) : "";
  const captureId = p.paymentId || p.captureId || null;

  const safeName = escapeHtml(p.name || "Guest");
  const safeService = escapeHtml(p.service || "TBD");
  const safeDate = escapeHtml(p.date || "TBD");
  const safeTime = escapeHtml(p.time || "TBD");
  const safeBarber = p.barberName ? escapeHtml(p.barberName) : "";
  const durationLine =
    p.serviceDuration != null && Number(p.serviceDuration) > 0
      ? `<p>${labels.lblServiceDuration}: ${escapeHtml(String(p.serviceDuration))} min</p>`
      : "";

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#111;">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;color:#b8860b;font-weight:700;">IFCDC BARBERS</p>
  <h2 style="margin:0 0 16px;color:#111;">${escapeHtml(labels.h2)}</h2>
  <p>${labels.lblName}: <strong>${safeName}</strong></p>
  ${safeBarber ? `<p>${labels.lblBarber}: <strong>${safeBarber}</strong></p>` : ""}
  <p>${labels.lblService}: <strong>${safeService}</strong></p>
  ${durationLine}
  <p>${labels.lblDate}: <strong>${safeDate}</strong></p>
  <p>${labels.lblTime}: <strong>${safeTime}</strong></p>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0;" />
  <p>${labels.lblServicePrice}: $${fmt(servicePrice)}</p>
  <p>Platform fee: $${fmt(platformFee)}</p>
  ${tip > 0 ? `<p>${labels.lblTip}: $${fmt(tip)}</p>` : ""}
  <p><strong>${labels.lblTotalCharged}: $${fmt(totalPaid)}</strong></p>
  ${bookingId ? `<p>Booking ID: <strong>${escapeHtml(bookingId)}</strong></p>` : ""}
  ${captureId ? `<p>${labels.lblPayRef}: ${escapeHtml(String(captureId))}</p>` : ""}
  <p style="margin-top:20px;font-size:13px;color:#555;">${escapeHtml(labels.thanks || "Thank you for booking with IFCDC Barbers.")}</p>
  ${publicWebFooterHtml()}
</div>
  `.trim();

  return {
    subject: labels.subjectFull,
    html,
    plain: htmlToPlainText(html),
    template: "customer_confirmation",
  };
}

/**
 * Admin/internal notification copy.
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
    status === PAYMENT_STATUS.PAID ||
    status === "paid_in_full"
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
  bookingId,
} = {}) {
  const resend = getResend();
  if (!resend) {
    const err = new Error("RESEND_API_KEY missing or invalid (must start with re_)");
    console.error("[booking-email] FAILED:", err.message);
    throw err;
  }

  const toAddr = String(email ?? "").trim();
  if (!isDeliverableCustomerEmail(toAddr)) {
    const err = new Error(
      `Customer email is missing or not deliverable: "${toAddr || "(empty)"}" — provide a real address at checkout`,
    );
    console.error("[booking-email] FAILED:", err.message, { bookingId: bookingId || bookingRow?.id });
    throw err;
  }

  const from = getMailFrom();
  if (!from) {
    const err = new Error(
      'MAIL_FROM is not set. Set MAIL_FROM=IFCDC Barbers <notifications@ifcdcbarbersapp.com> on Render backend696',
    );
    console.error("[booking-email] FAILED:", err.message);
    throw err;
  }

  const resolvedStatus = paymentStatus
    ? String(paymentStatus).toLowerCase()
    : bookingRow
      ? paymentStatusForEmailFromRow(bookingRow)
      : PAYMENT_STATUS.UNPAID;

  if (!shouldSendPaidConfirmationEmail(resolvedStatus)) {
    const err = new Error(
      `Booking confirmation email skipped — payment status "${resolvedStatus}" is not paid in full`,
    );
    console.error("[booking-email] FAILED:", err.message, {
      bookingId: bookingId || bookingRow?.id,
      to: toAddr,
    });
    throw err;
  }

  const payload = {
    name,
    service,
    date,
    time,
    barberName,
    servicePrice: servicePrice ?? totalPrice,
    totalPrice,
    platformFee,
    tipAmount,
    serviceDuration,
    language,
    bookingId: bookingId || bookingRow?.id,
    amountCharged: amountCharged ?? amountPaid ?? totalPaid,
    amountPaid,
    totalPaid: totalPaid ?? amountCharged ?? amountPaid,
    paymentId: paymentId || captureId,
    captureId: captureId || paymentId,
  };

  const customerContent = buildCustomerConfirmationEmail(payload);
  const adminContent = buildPaymentEmailContent(PAYMENT_STATUS.PAID_IN_FULL, payload);

  console.log("[booking-email] sending confirmation", {
    to: toAddr,
    bookingId: payload.bookingId || null,
    from: from.replace(/(.{2}).+(@.+)/, "$1***$2"),
    paymentStatus: resolvedStatus,
  });

  const customerResult = await sendEmail({
    to: toAddr,
    subject: customerContent.subject,
    html: customerContent.html,
    text: customerContent.plain,
    label: "booking-confirmation-customer",
  });
  if (customerResult.error) {
    const msg = customerResult.error.message || "Booking email send failed";
    console.error("[booking-email] Resend customer send FAILED:", msg, customerResult.error);
    throw new Error(msg);
  }

  const messageId = customerResult.data?.id;
  console.log("[booking-email] SENT OK", { to: toAddr, bookingId: payload.bookingId, messageId });

  const adminEmail = String(process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org").trim();
  let adminResult = null;
  if (adminEmail) {
    try {
      adminResult = await sendResendWithRetry(
        resend,
        {
          from,
          to: adminEmail,
          subject: adminContent.subject,
          html: adminContent.html,
          text: adminContent.plain,
        },
        "booking-admin-notification",
      );
    } catch (adminErr) {
      console.error(
        "[booking-email] admin copy FAILED:",
        adminErr instanceof Error ? adminErr.message : adminErr,
      );
    }
  }

  return {
    success: true,
    customer: customerResult,
    admin: adminResult,
    messageId,
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
  language,
} = {}) {
  const to = String(email || "").trim();
  if (!to || /@ifcdc\.local$/i.test(to) || /^pending\+/i.test(to)) {
    return { success: false, skipped: true, reason: "no_customer_email" };
  }
  if (!isResendConfigured()) {
    return { success: false, skipped: true, reason: "resend_not_configured" };
  }

  const { customerEmailLabels, tLabel } = require("./customerEmailI18n.cjs");
  const labels = customerEmailLabels(language);
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00");
  const amount = fmt(refundAmount);
  const safeName = escapeHtml(name || "Guest");
  const safeService = escapeHtml(service || "Appointment");
  const safeDate = escapeHtml(date || "TBD");
  const safeTime = escapeHtml(time || "TBD");
  const safeBarber = barberName ? escapeHtml(barberName) : "";
  const statusLabel = String(paymentStatus || "refunded").replace(/_/g, " ").toUpperCase();
  const subject = tLabel(labels, "refundSubject", { amount });
  const html = `
<h2>${escapeHtml(tLabel(labels, "refundTitle"))}</h2>
<p>${escapeHtml(tLabel(labels, "refundName"))}: ${safeName}</p>
${safeBarber ? `<p>${escapeHtml(tLabel(labels, "refundBarber"))}: ${safeBarber}</p>` : ""}
<p>${escapeHtml(tLabel(labels, "refundService"))}: ${safeService}</p>
<p>${escapeHtml(tLabel(labels, "refundDate"))}: ${safeDate}</p>
<p>${escapeHtml(tLabel(labels, "refundTime"))}: ${safeTime}</p>
<p><strong>${escapeHtml(tLabel(labels, "refundStatus"))}:</strong> ${escapeHtml(statusLabel)}</p>
<p>${escapeHtml(tLabel(labels, "refundAmount"))}: $${amount}</p>
${refundId ? `<p>${escapeHtml(tLabel(labels, "refundRef"))}: ${escapeHtml(String(refundId))}</p>` : ""}
${reason ? `<p>${escapeHtml(tLabel(labels, "refundReason"))}: ${escapeHtml(String(reason))}</p>` : ""}
<p>${escapeHtml(tLabel(labels, "refundFunds"))}</p>
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
  isDeliverableCustomerEmail,
  buildCustomerConfirmationEmail,
};
