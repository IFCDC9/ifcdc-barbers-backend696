/**
 * Unified booking payment settlement — full payment only (PayPal capture is source of truth).
 * @module bookingPaymentSettlement
 */

const DEFAULT_PLATFORM_FEE = 0.99;
const AMOUNT_TOLERANCE = 0.02;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Never accept stored/client platform_fee of 0 — minimum $0.99 at settlement. */
function resolvePlatformFeeUsd(rawFee) {
  const env = Number(process.env.PLATFORM_FEE);
  const configured =
    Number.isFinite(env) && env > 0 ? round2(env) : DEFAULT_PLATFORM_FEE;
  const n = Number(rawFee);
  if (Number.isFinite(n) && n >= configured - 0.001) return round2(n);
  return configured;
}

function withinAmount(a, b) {
  return Math.abs(round2(a) - round2(b)) <= AMOUNT_TOLERANCE;
}

const PAYMENT_STATUS = {
  UNPAID: "unpaid",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_MISMATCH: "payment_mismatch",
  PAID_IN_FULL: "paid_in_full",
  /** @deprecated legacy */
  PAID_FULL: "paid_full",
  /** @deprecated deposits removed */
  DEPOSIT_PAID: "deposit_paid",
  /** @deprecated */
  FAILED: "failed",
  /** @deprecated */
  PAID: "paid",
};

const CAPTURED_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUS.PAID_IN_FULL,
  PAYMENT_STATUS.PAID_FULL,
  PAYMENT_STATUS.PAID,
]);

function normalizePaymentStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "paid" || s === "paid_full" || s === "completed" || s === "deposit_paid" || s === "balance_due") {
    return PAYMENT_STATUS.PAID_IN_FULL;
  }
  if (s === "failed") return PAYMENT_STATUS.PAYMENT_FAILED;
  if (s === "pending") return PAYMENT_STATUS.UNPAID;
  if (s === "paid_in_full") return PAYMENT_STATUS.PAID_IN_FULL;
  return s || PAYMENT_STATUS.UNPAID;
}

function isCapturedPaymentStatus(status) {
  const n = normalizePaymentStatus(status);
  return n === PAYMENT_STATUS.PAID_IN_FULL;
}

function extractPayPalCapturedUsd(capture) {
  const units = Array.isArray(capture?.purchase_units) ? capture.purchase_units : [];
  for (const pu of units) {
    const caps = pu?.payments?.captures;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      const val = c?.amount?.value;
      if (val != null && String(val).trim() !== "") {
        const n = round2(Number(val));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return null;
}

function computeSettlementFromCapture(input) {
  const servicePrice = round2(Math.max(0, Number(input.servicePrice) || 0));
  const platformFee = resolvePlatformFeeUsd(input.platformFee);
  const tipAmount = round2(Math.max(0, Number(input.tipAmount) || 0));
  const capturedUsd = round2(Number(input.capturedUsd) || 0);
  const captureId = input.captureId ? String(input.captureId).trim() : "";
  const provider = String(input.paymentProvider || "paypal").toLowerCase();

  if (!captureId) {
    return {
      ok: false,
      error: "no_capture_id",
      paymentStatus: PAYMENT_STATUS.PAYMENT_FAILED,
      message: "Payment failed — booking not confirmed.",
    };
  }

  if (!Number.isFinite(capturedUsd) || capturedUsd <= 0) {
    return {
      ok: false,
      error: "no_capture_amount",
      paymentStatus: PAYMENT_STATUS.PAYMENT_FAILED,
      message: "Payment failed — booking not confirmed.",
    };
  }

  const computedFull = round2(servicePrice + platformFee + tipAmount);
  const expectedOverride = round2(Number(input.expectedTotalUsd));
  const fullRequired =
    Number.isFinite(expectedOverride) && expectedOverride > 0 ? expectedOverride : computedFull;

  if (!withinAmount(capturedUsd, fullRequired)) {
    return {
      ok: false,
      error: "payment_mismatch",
      paymentStatus: PAYMENT_STATUS.PAYMENT_MISMATCH,
      message: `Captured $${capturedUsd.toFixed(2)} does not match required total ($${fullRequired.toFixed(2)}).`,
      capturedUsd,
      fullRequired,
    };
  }

  const paymentMethod = provider === "stripe" ? "card" : provider === "paypal" ? "paypal" : provider;

  return {
    ok: true,
    servicePrice,
    platformFee,
    tipAmount,
    totalDue: fullRequired,
    depositAmount: 0,
    amountCharged: capturedUsd,
    amountPaid: capturedUsd,
    balanceDue: 0,
    remainingBalance: 0,
    paymentStatus: PAYMENT_STATUS.PAID_IN_FULL,
    paymentType: "full",
    paymentMethod,
    paymentProvider: provider,
    captureId,
    isPaidBooking: true,
    bookingStatus: "confirmed",
    canSendPaidConfirmationEmail: true,
  };
}

function paymentStatusForEmailFromRow(row) {
  const captureId =
    row.paypal_capture_id || row.stripe_payment_intent_id || row.payment_id || null;
  const status = normalizePaymentStatus(row.payment_status);
  const amountPaid = round2(
    Number(row.amount_charged ?? row.amount_paid ?? row.total_paid ?? 0),
  );

  if (
    status === PAYMENT_STATUS.PAYMENT_MISMATCH ||
    status === PAYMENT_STATUS.PAYMENT_FAILED
  ) {
    return status;
  }

  if (
    captureId &&
    amountPaid > 0 &&
    (status === PAYMENT_STATUS.PAID_IN_FULL || isCapturedPaymentStatus(status))
  ) {
    return PAYMENT_STATUS.PAID_IN_FULL;
  }

  if (!captureId || !isBookingPaymentSettled(row)) {
    return PAYMENT_STATUS.UNPAID;
  }

  return PAYMENT_STATUS.PAID_IN_FULL;
}

function shouldSendPaidConfirmationEmail(paymentStatus) {
  return normalizePaymentStatus(paymentStatus) === PAYMENT_STATUS.PAID_IN_FULL;
}

function bookingPaymentViewFromRow(row) {
  const servicePrice = round2(
    Number(row.service_price ?? row.total_price ?? row.amount ?? 0),
  );
  const platformFee = resolvePlatformFeeUsd(row.platform_fee);
  const tipAmount = round2(Number(row.tip_amount ?? 0));
  const amountCharged = round2(
    Number(row.amount_charged ?? row.amount_paid ?? row.total_paid ?? 0),
  );
  const amountPaid = amountCharged;
  const totalDue = round2(Number(row.total_amount ?? servicePrice + platformFee + tipAmount));
  const paymentStatus = normalizePaymentStatus(row.payment_status);
  const captureId = row.paypal_capture_id || row.stripe_payment_intent_id || row.payment_id || null;
  const transactionId = captureId ? String(captureId) : null;
  const paymentMethod =
    String(row.payment_method || "").trim() ||
    (String(row.payment_provider || "") === "stripe" ? "card" : String(row.payment_provider || "paypal"));

  const isPaidInFull =
    paymentStatus === PAYMENT_STATUS.PAID_IN_FULL &&
    Boolean(transactionId) &&
    amountPaid > 0 &&
    withinAmount(amountPaid, servicePrice + platformFee + tipAmount);

  let paymentStatusLabel = "PAYMENT NOT COMPLETED";
  if (isPaidInFull) paymentStatusLabel = "PAID IN FULL";
  else if (paymentStatus === PAYMENT_STATUS.PAYMENT_FAILED) paymentStatusLabel = "PAYMENT FAILED";
  else if (paymentStatus === PAYMENT_STATUS.PAYMENT_MISMATCH) paymentStatusLabel = "PAYMENT MISMATCH";

  return {
    servicePrice,
    platformFee,
    tipAmount,
    totalDue,
    depositAmount: 0,
    depositPaidAmount: 0,
    amountCharged,
    amountPaid,
    balanceDue: 0,
    remainingBalance: 0,
    paymentStatus,
    paymentMethod,
    paymentProvider: row.payment_provider || null,
    captureId: transactionId,
    transactionId,
    isPaidInFull,
    isDepositPaid: false,
    paidInFull: isPaidInFull,
    depositPaid: false,
    paymentStatusLabel,
  };
}

function isBookingPaymentSettled(row) {
  const view = bookingPaymentViewFromRow(row);
  return Boolean(view.captureId && view.amountPaid > 0 && view.isPaidInFull);
}

function bookingEmailPayloadFromRow(row, overrides = {}) {
  const view = bookingPaymentViewFromRow(row);
  return {
    paymentStatus: paymentStatusForEmailFromRow(row),
    servicePrice: view.servicePrice,
    platformFee: view.platformFee,
    tipAmount: view.tipAmount,
    amountCharged: view.amountCharged,
    amountPaid: view.amountPaid,
    balanceDue: 0,
    captureId: view.captureId,
    paymentId: view.captureId,
    bookingRow: row,
    ...overrides,
  };
}

function sqlCapturedPaymentStatuses() {
  return "('paid_in_full', 'paid_full', 'paid', 'deposit_paid')";
}

function settlementUpdateParams(bookingId, settlement, captureId) {
  return {
    sql: `UPDATE bookings SET
      payment_status = $2,
      booking_status = $3,
      is_paid_booking = $4,
      paypal_capture_id = $5,
      payment_method = $6,
      payment_type = $7,
      service_price = $8,
      platform_fee = $9,
      tip_amount = $10,
      amount_charged = $11,
      amount_paid = $11,
      total_paid = $11,
      deposit_amount = 0,
      balance_due = 0,
      remaining_balance = 0,
      total_amount = $12,
      platform_fee_status = 'collected'
    WHERE id = $1::uuid`,
    values: [
      bookingId,
      settlement.paymentStatus,
      settlement.bookingStatus,
      settlement.isPaidBooking,
      captureId,
      settlement.paymentMethod,
      settlement.paymentType,
      settlement.servicePrice,
      settlement.platformFee,
      settlement.tipAmount,
      settlement.amountCharged,
      settlement.totalDue,
    ],
  };
}

module.exports = {
  DEFAULT_PLATFORM_FEE,
  resolvePlatformFeeUsd,
  AMOUNT_TOLERANCE,
  PAYMENT_STATUS,
  CAPTURED_PAYMENT_STATUSES,
  round2,
  withinAmount,
  normalizePaymentStatus,
  isCapturedPaymentStatus,
  extractPayPalCapturedUsd,
  computeSettlementFromCapture,
  bookingPaymentViewFromRow,
  isBookingPaymentSettled,
  paymentStatusForEmailFromRow,
  bookingEmailPayloadFromRow,
  shouldSendPaidConfirmationEmail,
  settlementUpdateParams,
  sqlCapturedPaymentStatuses,
};
