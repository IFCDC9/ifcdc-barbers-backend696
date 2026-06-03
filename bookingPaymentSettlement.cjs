/**
 * Unified booking payment settlement — PayPal capture amount is the source of truth.
 * Never infer payment from payment_type / checkout labels.
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
  DEPOSIT_PAID: "deposit_paid",
  PAID_FULL: "paid_full",
  /** @deprecated */
  FAILED: "failed",
  /** @deprecated */
  PAID: "paid",
};

const CAPTURED_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUS.PAID_FULL,
  PAYMENT_STATUS.DEPOSIT_PAID,
  PAYMENT_STATUS.PAID,
]);

function normalizePaymentStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "paid") return PAYMENT_STATUS.PAID_FULL;
  if (s === "completed") return PAYMENT_STATUS.PAID_FULL;
  if (s === "failed") return PAYMENT_STATUS.PAYMENT_FAILED;
  if (s === "pending") return PAYMENT_STATUS.UNPAID;
  if (s === "balance_due") return PAYMENT_STATUS.DEPOSIT_PAID;
  return s || PAYMENT_STATUS.UNPAID;
}

function isCapturedPaymentStatus(status) {
  const n = normalizePaymentStatus(status);
  return n === PAYMENT_STATUS.PAID_FULL || n === PAYMENT_STATUS.DEPOSIT_PAID;
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

/**
 * @param {{
 *   servicePrice: number,
 *   depositAmount?: number,
 *   platformFee?: number,
 *   tipAmount?: number,
 *   capturedUsd: number,
 *   paymentProvider?: string,
 *   captureId?: string | null,
 * }} input
 */
function computeSettlementFromCapture(input) {
  const servicePrice = round2(Math.max(0, Number(input.servicePrice) || 0));
  const depositAmount = round2(Math.max(0, Number(input.depositAmount) || 0));
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

  const fullRequired = round2(servicePrice + platformFee + tipAmount);
  const depositRequired = round2(depositAmount + platformFee + tipAmount);

  let paymentStatus = PAYMENT_STATUS.UNPAID;
  let balanceDue = round2(servicePrice);
  let paymentType = "full";

  if (depositAmount > 0) {
    paymentType = "deposit";
    if (withinAmount(capturedUsd, fullRequired)) {
      paymentStatus = PAYMENT_STATUS.PAID_FULL;
      balanceDue = 0;
    } else if (withinAmount(capturedUsd, depositRequired)) {
      paymentStatus = PAYMENT_STATUS.DEPOSIT_PAID;
      balanceDue = round2(Math.max(0, servicePrice - depositAmount));
    } else {
      return {
        ok: false,
        error: "payment_mismatch",
        paymentStatus: PAYMENT_STATUS.PAYMENT_MISMATCH,
        message: `Captured $${capturedUsd.toFixed(2)} does not match required deposit ($${depositRequired.toFixed(2)}) or full total ($${fullRequired.toFixed(2)}).`,
        capturedUsd,
        fullRequired,
        depositRequired,
      };
    }
  } else {
    if (!withinAmount(capturedUsd, fullRequired)) {
      return {
        ok: false,
        error: "payment_mismatch",
        paymentStatus: PAYMENT_STATUS.PAYMENT_MISMATCH,
        message: `Captured $${capturedUsd.toFixed(2)} does not match required full total ($${fullRequired.toFixed(2)}).`,
        capturedUsd,
        fullRequired,
      };
    }
    paymentStatus = PAYMENT_STATUS.PAID_FULL;
    balanceDue = 0;
  }

  const amountCharged = capturedUsd;
  const amountPaid = capturedUsd;
  const paymentMethod = provider === "stripe" ? "card" : provider === "paypal" ? "paypal" : provider;

  return {
    ok: true,
    servicePrice,
    platformFee,
    tipAmount,
    totalDue: fullRequired,
    depositAmount,
    amountCharged,
    amountPaid,
    balanceDue,
    remainingBalance: balanceDue,
    paymentStatus,
    paymentType,
    paymentMethod,
    paymentProvider: provider,
    captureId,
    isPaidBooking: isCapturedPaymentStatus(paymentStatus),
    bookingStatus: "confirmed",
    canSendPaidConfirmationEmail: true,
  };
}

/**
 * Derive email template status from DB row — never from payment_type alone.
 * @param {Record<string, unknown>} row
 */
function paymentStatusForEmailFromRow(row) {
  const captureId =
    row.paypal_capture_id || row.stripe_payment_intent_id || row.payment_id || null;
  const status = normalizePaymentStatus(row.payment_status);

  if (
    status === PAYMENT_STATUS.PAYMENT_MISMATCH ||
    status === PAYMENT_STATUS.PAYMENT_FAILED ||
    status === PAYMENT_STATUS.UNPAID
  ) {
    return status;
  }

  if (!captureId || !isBookingPaymentSettled(row)) {
    return PAYMENT_STATUS.UNPAID;
  }

  const view = bookingPaymentViewFromRow(row);
  if (view.isPaidInFull) return PAYMENT_STATUS.PAID_FULL;
  if (view.isDepositPaid) return PAYMENT_STATUS.DEPOSIT_PAID;
  return PAYMENT_STATUS.UNPAID;
}

function shouldSendPaidConfirmationEmail(paymentStatus) {
  const s = normalizePaymentStatus(paymentStatus);
  return s === PAYMENT_STATUS.PAID_FULL || s === PAYMENT_STATUS.DEPOSIT_PAID;
}

/**
 * @param {Record<string, unknown>} row
 */
function bookingPaymentViewFromRow(row) {
  const servicePrice = round2(
    Number(row.service_price ?? row.total_price ?? row.amount ?? 0),
  );
  const depositAmount = round2(Number(row.deposit_amount ?? 0));
  const platformFee = resolvePlatformFeeUsd(row.platform_fee);
  const tipAmount = round2(Number(row.tip_amount ?? 0));
  const amountCharged = round2(
    Number(row.amount_charged ?? row.amount_paid ?? row.total_paid ?? 0),
  );
  const amountPaid = amountCharged;
  const balanceDue = round2(
    Number(row.balance_due ?? row.remaining_balance ?? 0),
  );
  const totalDue = round2(Number(row.total_amount ?? servicePrice + platformFee + tipAmount));
  const paymentStatus = normalizePaymentStatus(row.payment_status);
  const captureId = row.paypal_capture_id || row.stripe_payment_intent_id || row.payment_id || null;
  const transactionId = captureId ? String(captureId) : null;
  const paymentMethod =
    String(row.payment_method || "").trim() ||
    (String(row.payment_provider || "") === "stripe" ? "card" : String(row.payment_provider || "paypal"));

  const isPaidInFull =
    paymentStatus === PAYMENT_STATUS.PAID_FULL &&
    Boolean(transactionId) &&
    amountPaid > 0 &&
    balanceDue <= AMOUNT_TOLERANCE &&
    withinAmount(amountPaid, servicePrice + platformFee + tipAmount);

  const isDepositPaid =
    paymentStatus === PAYMENT_STATUS.DEPOSIT_PAID && Boolean(transactionId) && amountPaid > 0;

  const depositPaidAmount = isDepositPaid
    ? round2(Math.min(depositAmount, Math.max(0, amountPaid - platformFee - tipAmount)))
    : 0;

  let paymentStatusLabel = "PAYMENT NOT COMPLETED";
  if (isPaidInFull) paymentStatusLabel = "PAID IN FULL";
  else if (isDepositPaid) paymentStatusLabel = "DEPOSIT PAID";
  else if (paymentStatus === PAYMENT_STATUS.PAYMENT_FAILED) paymentStatusLabel = "PAYMENT FAILED";
  else if (paymentStatus === PAYMENT_STATUS.PAYMENT_MISMATCH) paymentStatusLabel = "PAYMENT MISMATCH";

  return {
    servicePrice,
    platformFee,
    tipAmount,
    totalDue,
    depositAmount,
    depositPaidAmount,
    amountCharged,
    amountPaid,
    balanceDue,
    remainingBalance: balanceDue,
    paymentStatus,
    paymentMethod,
    paymentProvider: row.payment_provider || null,
    captureId: transactionId,
    transactionId,
    isPaidInFull,
    isDepositPaid,
    /** @deprecated use isPaidInFull */
    paidInFull: isPaidInFull,
    /** @deprecated use isDepositPaid */
    depositPaid: isDepositPaid,
    paymentStatusLabel,
  };
}

function isBookingPaymentSettled(row) {
  const view = bookingPaymentViewFromRow(row);
  if (!view.captureId || view.amountPaid <= 0) return false;
  if (view.isPaidInFull) return true;
  if (view.isDepositPaid && view.balanceDue > AMOUNT_TOLERANCE) return true;
  return false;
}

/** Email + API payload from a bookings row (never uses payment_type alone). */
function bookingEmailPayloadFromRow(row, overrides = {}) {
  const view = bookingPaymentViewFromRow(row);
  return {
    paymentStatus: paymentStatusForEmailFromRow(row),
    servicePrice: view.servicePrice,
    platformFee: view.platformFee,
    tipAmount: view.tipAmount,
    amountCharged: view.amountCharged,
    amountPaid: view.amountPaid,
    balanceDue: view.balanceDue,
    captureId: view.captureId,
    paymentId: view.captureId,
    bookingRow: row,
    ...overrides,
  };
}

function sqlCapturedPaymentStatuses() {
  return "('paid_full', 'deposit_paid', 'paid')";
}

/** SQL SET clause values for a successful settlement UPDATE. */
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
      balance_due = $12,
      remaining_balance = $12,
      total_amount = $13,
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
      settlement.balanceDue,
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
