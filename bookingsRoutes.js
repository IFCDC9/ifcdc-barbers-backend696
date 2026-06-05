import express from "express";
import { extractBearerToken, resolveAuthPayload, requireAuth } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { dbQuery } from "./db.js";
import {
  BOOKING_STATUSES,
  STATUS_LABELS,
  canTransition,
  isValidStatus,
  loadStatusTimeline,
  recordStatusChange,
} from "./bookingStatusEngine.js";
import { getPayPalHttpClient, ordersGetRequest } from "./paypalClient.js";
import { roundMoney2, depositsAllowedForBooking, enforcePlatformFeeOnBreakdown } from "./styleBookingPricing.js";
import {
  assertSlotWithinAvailability,
  loadBarberDepositPricingOpts,
  loadBarberSettingsRow,
  resolveOrCreateBarberClientId,
} from "./barberScope.js";
import { computeStyleBookingBreakdown } from "./bookingBreakdown.js";
import { BARBER_PLATFORM_FEE_USD, barberDepositsEffective } from "./subscriptionTier.js";
import { insertBarberFeeLedgerRow } from "./barberFeeLedger.js";
import { createDepositPaymentLink } from "./depositPaymentLink.js";
import { tenantMatches } from "./securityPolicy.js";
import { createPlatformBookingOpsGuard, isPlatformBookingOpsJwt } from "./bookingsAdminGuard.js";
import { writeSecurityAudit } from "./auditSecurity.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveBarberIdentity,
  barberIdForTable,
  BARBER_RESOLVE_MSG,
  isBarberIdentityDbError,
  logDbInsertDebug,
  assertNotUuidForBigintBarberId,
  resolvedBarberDbIdOnly,
  getTableBarberIdType,
} = require("./barberIdentity.cjs");
const {
  computeSettlementFromCapture,
  bookingEmailPayloadFromRow,
  PAYMENT_STATUS,
  shouldSendPaidConfirmationEmail,
} = require("./bookingPaymentSettlement.cjs");
const { isDeliverableCustomerEmail } = require("./bookingEmail.cjs");
const { refundPayPalCapture, round2: roundRefundMoney } = require("./paypalRefund.cjs");
const { sendBookingRefundEmail } = require("./bookingEmail.cjs");
const { assessBookingRemoval } = require("./bookingDeletePolicy.cjs");

const BOOKING_ACTIVE = "deleted_at IS NULL";
const BOOKING_ACTIVE_B = "b.deleted_at IS NULL";

function bookingHasRefundableCapture(booking) {
  const captureId = String(booking?.paypal_capture_id || "").trim();
  if (!captureId) return false;
  const status = String(booking?.payment_status || "").toLowerCase();
  if (status === "refunded" || status === "partially_refunded" || status === "refund_pending") {
    return false;
  }
  const paid = Number(booking?.amount_paid ?? booking?.amount_charged ?? booking?.total_paid ?? 0);
  if (paid > 0.01) return true;
  return ["paid", "paid_full", "paid_in_full", "deposit_paid"].includes(status);
}

function getAuthPayload(req) {
  const token = extractBearerToken(req.get("authorization"));
  return resolveAuthPayload(token);
}

function getAuthUserId(req) {
  const payload = getAuthPayload(req);
  return payload?.id ? String(payload.id) : null;
}

function getAuthRole(req) {
  const payload = getAuthPayload(req);
  return payload?.role ? String(payload.role) : "";
}

async function resolveBusinessIdForBarber(barberId) {
  if (barberId == null || String(barberId).trim() === "") return null;
  const r = await dbQuery(`SELECT business_id FROM barbers WHERE id::text = $1 LIMIT 1`, [String(barberId)]);
  const v = r.rows?.[0]?.business_id;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function canMarkBookingPaid(req, bookingRow) {
  // x-admin-key (ADMIN_SECRET) always allowed.
  const adminKey = String(req.get("x-admin-key") || "").trim();
  const expected = String(process.env.ADMIN_SECRET || "").trim();
  if (expected && adminKey && adminKey === expected) return true;

  const payload = getAuthPayload(req);
  if (!payload) return false;
  const role = String(payload.role || "").trim().toLowerCase();

  if (isJwtGlobalSuperScope(payload) || role === "admin") return true;

  if (role === "shop_owner") {
    const userId = getAuthUserId(req);
    if (!userId) return false;
    const u = await dbQuery(`SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`, [String(userId)]);
    const myBid = u.rows?.[0]?.business_id;
    return tenantMatches(myBid, bookingRow?.business_id);
  }

  if (role !== "barber") return false;

  const userId = getAuthUserId(req);
  if (!userId) return false;

  const r = await dbQuery("SELECT barber_id FROM app_users WHERE id = $1 LIMIT 1", [String(userId)]);
  const myBarberId = r.rows?.[0]?.barber_id;
  if (myBarberId == null) return false;

  return Number(myBarberId) === Number(bookingRow?.barber_id);
}

async function loadStyleRow(styleId) {
  const id = String(styleId || "").trim();
  if (!id) return null;
  const r = await dbQuery(
    `SELECT id, barber_id, title, image_url, price::float8 AS price FROM styles WHERE id = $1::uuid LIMIT 1`,
    [id]
  );
  return r.rows?.[0] || null;
}

/**
 * Phone AURA (Twilio): pay-in-person row, no PayPal. Caller must send `channel: "aura_voice"` + `x-voice-booking-secret`.
 */
export async function insertAuraVoiceBookingRow(body, sendBookingEmail) {
  const customerName = String(body.name || "").trim();
  const customerEmail = String(body.email || "").trim();
  const customerPhone = String(body.phone || "").trim();
  const barberId = Number(body.barberId ?? body.barber);
  const barberName = String(body.barber || "").trim();
  const dateStr = String(body.date || "").trim();
  const timeStr = String(body.time || "").trim();
  const callSid = String(body.callSid || "").trim();
  const styleIdRaw = String(body.styleId || "").trim();
  const serviceHint = String(body.service || "").trim();

  if (!customerName || !customerEmail || !dateStr || !timeStr || !Number.isFinite(barberId)) {
    return { ok: false, status: 400, error: "missing_fields", message: "Missing required booking fields" };
  }
  if (!callSid) {
    return { ok: false, status: 400, error: "call_sid_required", message: "callSid required for voice booking" };
  }

  let styleRow = null;
  if (styleIdRaw) {
    styleRow = await loadStyleRow(styleIdRaw);
    if (!styleRow) {
      return { ok: false, status: 400, error: "style_not_found", message: "Style not found" };
    }
    if (Number(styleRow.barber_id) !== barberId) {
      return { ok: false, status: 400, error: "barber_mismatch", message: "Style does not match selected barber" };
    }
  }

  const serviceTitle = styleRow
    ? String(styleRow.title || "").trim() || "Style"
    : serviceHint || "Phone booking";
  const styleImageUrl = styleRow?.image_url ? String(styleRow.image_url) : null;
  const styleUuid = styleRow?.id || null;
  const totalPrice = roundMoney2(
    styleRow && Number(styleRow.price) > 0 ? Number(styleRow.price) : Number(body.price) > 0 ? Number(body.price) : 25
  );

  let settingsRow = null;
  try {
    settingsRow = await loadBarberSettingsRow(barberId);
  } catch {
    settingsRow = null;
  }
  const barberPlatformFee = roundMoney2(BARBER_PLATFORM_FEE_USD);
  const barberPayoutAmount = roundMoney2(Math.max(0, totalPrice - barberPlatformFee));
  const totalAmount = roundMoney2(totalPrice);

  const depositTierOk = settingsRow ? barberDepositsEffective(settingsRow) : false;
  const depositCfg = Number(settingsRow?.deposit_amount) || 0;
  const depositEnabledForBarber = Boolean(settingsRow?.booking_deposit_enabled);
  const depositRequired =
    depositTierOk && depositEnabledForBarber && depositCfg > 0 && totalPrice > 0;
  const depositAmountVoice = depositRequired
    ? roundMoney2(Math.min(depositCfg, Math.max(0.01, totalPrice - 0.01)))
    : 0;
  const depositStatus = depositRequired ? "pending" : "not_required";

  let clientId = null;
  try {
    clientId = await resolveOrCreateBarberClientId(barberId, customerName, customerEmail);
  } catch {
    /* optional */
  }

  const stamp = Date.now();
  const voiceOrderId = `voice_order:${callSid}:${stamp}`;
  const voiceCaptureId = `voice_cap:${callSid}:${stamp}`;
  const voiceBizId = await resolveBusinessIdForBarber(barberId);

  const insert = await dbQuery(
    `INSERT INTO bookings
     (user_id, customer_name, customer_email, phone, barber_name, barber_id, client_id, service, date, time, amount,
      total_price, deposit_amount, amount_paid, remaining_balance,
      payment_type, payment_status, payment_provider, paypal_order_id, paypal_capture_id,
      style_id, style_title, style_image_url, tip_amount, total_paid,
      platform_fee, total_amount, booking_status, is_paid_booking,
      deposit_required, deposit_status, deposit_payment_link, deposit_transaction_id, deposit_paypal_order_id,
      platform_fee_status, barber_payout_amount, barber_fee_billed, business_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::time,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34,$35,$36,$37,$38)
     ON CONFLICT (paypal_capture_id) DO NOTHING
     RETURNING id, created_at`,
    [
      null,
      customerName,
      customerEmail,
      customerPhone || null,
      barberName || null,
      barberId,
      clientId,
      serviceTitle,
      dateStr,
      timeStr,
      totalPrice,
      totalPrice,
      depositRequired ? depositAmountVoice : 0,
      0,
      totalPrice,
      depositRequired ? "deposit" : "full",
      "pay_in_person",
      "voice",
      voiceOrderId,
      voiceCaptureId,
      styleUuid,
      serviceTitle,
      styleImageUrl,
      0,
      0,
      barberPlatformFee,
      totalAmount,
      "pending",
      false,
      depositRequired,
      depositStatus,
      null,
      null,
      null,
      "pending",
      barberPayoutAmount,
      false,
      voiceBizId,
    ]
  );

  if (!insert.rows?.length) {
    const existing = await dbQuery(
      `SELECT id, customer_name, customer_email, barber_name, service, date, time,
              service_price, total_price, deposit_amount, amount_paid, amount_charged,
              balance_due, remaining_balance, platform_fee, tip_amount, payment_status,
              payment_method, payment_provider, paypal_capture_id
       FROM bookings WHERE paypal_capture_id = $1 LIMIT 1`,
      [voiceCaptureId],
    );
    const row = existing.rows?.[0];
    let emailSent = false;
    let emailError = null;
    if (row && sendBookingEmail && customerEmail) {
      try {
        let bookingLanguage = "en";
        try {
          const st = await loadBarberSettingsRow(barberId);
          bookingLanguage = st?.language || "en";
        } catch {
          /* default en */
        }
        const r = await sendBookingEmail({
          name: row.customer_name || customerName,
          email: row.customer_email || customerEmail,
          barberName: row.barber_name || barberName,
          date: String(row.date ?? dateStr),
          time: String(row.time ?? timeStr),
          service: row.service || serviceTitle,
          language: bookingLanguage,
          ...bookingEmailPayloadFromRow(row),
        });
        emailSent = !r?.error;
        emailError = r?.error || null;
      } catch (e) {
        emailSent = false;
        emailError = e?.message || String(e);
      }
    }
    return { ok: true, deduped: true, booking: row || null, emailSent, emailError };
  }

  const bookingId = insert.rows[0].id;
  let emailSent = false;
  let emailError = null;
  let bookingLanguage = "en";
  try {
    const st = await loadBarberSettingsRow(barberId);
    bookingLanguage = st?.language || "en";
  } catch {
    /* default en */
  }
  try {
    const r = await sendBookingEmail?.({
      name: customerName,
      email: customerEmail,
      barberName,
      date: dateStr,
      time: timeStr,
      service: serviceTitle,
      language: bookingLanguage,
      paymentStatus: PAYMENT_STATUS.UNPAID,
      servicePrice: totalPrice,
      platformFee: 0.99,
      tipAmount: 0,
      amountCharged: 0,
      balanceDue: totalPrice,
    });
    emailSent = !r?.error;
    emailError = r?.error || null;
  } catch (e) {
    emailSent = false;
    emailError = e?.message || String(e);
  }

  return {
    ok: true,
    booking: {
      id: bookingId,
      barberId,
      barberName,
      service: serviceTitle,
      styleId: styleUuid,
      date: dateStr,
      time: timeStr,
      name: customerName,
      customerEmail,
      phone: customerPhone || null,
      price: totalPrice,
      totalPrice,
      paymentStatus: "pay_in_person",
      paymentProvider: "voice",
      depositRequired,
      depositAmount: depositRequired ? depositAmountVoice : 0,
      depositStatus,
      depositPaymentLink: null,
    },
    emailSent,
    emailError,
  };
}

function normalizePaymentType(_body, _depositOpts = {}) {
  return "full";
}

function extractCaptureIdFromOrder(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const pu of units) {
    const caps = pu?.payments?.captures;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      if (c?.id) return String(c.id);
    }
  }
  return null;
}

function extractCaptureAmount(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const pu of units) {
    const caps = pu?.payments?.captures;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      const value = Number(c?.amount?.value);
      const currency = String(c?.amount?.currency_code || "").toUpperCase();
      if (Number.isFinite(value) && currency) return { value, currency };
    }
  }
  return null;
}

async function verifyPayPalCapture({ paypalOrderId, paypalCaptureId, expectedAmount }) {
  const client = getPayPalHttpClient();
  const req = ordersGetRequest(paypalOrderId);
  const r = await client.execute(req);
  const order = r?.result;
  const status = String(order?.status || "").toUpperCase();
  if (status !== "COMPLETED") {
    return { ok: false, error: "paypal_not_completed", message: `Order status ${status || "unknown"}` };
  }
  const capId = extractCaptureIdFromOrder(order);
  if (!capId || capId !== paypalCaptureId) {
    return { ok: false, error: "paypal_capture_mismatch", message: "Capture id mismatch" };
  }
  const amt = extractCaptureAmount(order);
  if (!amt || amt.currency !== "USD") {
    return { ok: false, error: "paypal_amount_missing", message: "Missing capture amount" };
  }
  if (Math.abs(Number(amt.value) - Number(expectedAmount)) > 0.009) {
    return { ok: false, error: "amount_mismatch", message: "Captured amount mismatch" };
  }
  return { ok: true, order };
}

/**
 * Resolves whether `req.user` may read/mutate a given bookings row.
 * Mirrors the access matrix documented on GET /api/bookings/:id and is reused
 * by every per-id mutation endpoint. Returns null when access is denied so the
 * caller can 404 (don't leak existence).
 */
async function resolveBookingActor(req, booking) {
  const role = String(req.user?.role || "").trim().toLowerCase();
  const userId = String(req.user?.id || "").trim();
  const userEmail = String(req.user?.email || "").trim().toLowerCase();
  const payload = getAuthPayload(req);
  const isPlatformSuper = payload ? isJwtGlobalSuperScope(payload) : false;

  let allowed = false;
  let normalizedRole = role || "customer";

  if (isPlatformSuper || role === "super_admin" || role === "admin") {
    allowed = true;
    normalizedRole = role || "admin";
  } else if (role === "shop_owner") {
    if (userId) {
      const u = await dbQuery(
        `SELECT business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [userId],
      );
      allowed = tenantMatches(u.rows?.[0]?.business_id, booking.business_id);
    }
    normalizedRole = "shop_owner";
  } else if (role === "barber") {
    if (userId) {
      const u = await dbQuery(
        `SELECT barber_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [userId],
      );
      const myBarber = u.rows?.[0]?.barber_id;
      allowed =
        myBarber != null &&
        booking.barber_id != null &&
        String(myBarber) === String(booking.barber_id);
    }
    normalizedRole = "barber";
  } else {
    const ownsViaUserId =
      booking.user_id != null && userId && String(booking.user_id) === userId;
    const ownsViaEmail =
      !!userEmail &&
      !!booking.customer_email &&
      String(booking.customer_email).trim().toLowerCase() === userEmail;
    allowed = Boolean(ownsViaUserId || ownsViaEmail);
    normalizedRole = "customer";
  }

  if (!allowed) return null;
  return {
    role: normalizedRole,
    isPlatformSuper,
    userId: userId || null,
    userEmail: userEmail || null,
    actor: {
      userId: userId || null,
      role: normalizedRole,
      email: req.user?.email || null,
    },
  };
}

export function createBookingsRouter({ sendBookingEmail, sendBookingPush, requireAdmin } = {}) {
  const router = express.Router();
  const guard = typeof requireAdmin === "function" ? requireAdmin : (_req, _res, next) => next();
  const platformOpsGuard = createPlatformBookingOpsGuard({ resolveAuthPayload });

  /**
   * Wrap the injected push dispatcher so route handlers can fire-and-forget
   * without worrying about boot order or environment. ALWAYS resolves; never
   * rejects — push failures must not impact booking, payment, or auth flows.
   */
  function dispatchBookingPush(args) {
    if (typeof sendBookingPush !== "function") return Promise.resolve({ ok: true, sent: 0 });
    try {
      return Promise.resolve(sendBookingPush({ ...args, dbQuery })).catch((e) => {
        console.warn("[push] dispatchBookingPush rejected:", e?.message || e);
        return { ok: false, sent: 0 };
      });
    } catch (e) {
      console.warn("[push] dispatchBookingPush threw synchronously:", e?.message || e);
      return Promise.resolve({ ok: false, sent: 0 });
    }
  }

  // Admin list (scoped for shop_owner — see bookingsAdminGuard)
  router.get("/api/admin/bookings", guard, async (req, res) => {
    const scope = req.bookingsAdminScope || { all: true };
    const tenantWhere = scope.all
      ? ` WHERE ${BOOKING_ACTIVE} `
      : ` WHERE business_id = $1 AND ${BOOKING_ACTIVE} `;
    const tenantParams = scope.all ? [] : [scope.businessId];
    const r = await dbQuery(
      `SELECT id, user_id, customer_name, customer_email, barber_name, barber_id, business_id, client_id, service, date, time,
              phone,
              amount, service_price, total_price, deposit_amount, amount_paid, amount_charged, balance_due, remaining_balance,
              payment_type, payment_status, payment_method, payment_provider, paypal_order_id, paypal_capture_id,
              style_id, style_title, style_image_url, tip_amount, total_paid,
              platform_fee, platform_fee_status, barber_payout_amount, total_amount, booking_status, is_paid_booking, created_at
       FROM bookings
       ${tenantWhere}
       ORDER BY created_at DESC
       LIMIT 500`,
      tenantParams
    );
    res.json({ bookings: r.rows || [] });
  });

  const BOOKING_DETAIL_SELECT = `SELECT b.id, b.user_id, b.customer_name, b.customer_email, b.barber_name, b.barber_id, b.business_id, b.client_id, b.service, b.service_duration_minutes,
              b.date, b.time,
              b.phone,
              b.amount, b.service_price, b.total_price, b.deposit_amount, b.amount_paid, b.amount_charged, b.balance_due, b.remaining_balance,
              b.payment_type, b.payment_status, b.payment_method, b.payment_provider, b.paypal_order_id, b.paypal_capture_id,
              b.style_id, b.style_title, b.style_image_url, b.tip_amount, b.total_paid,
              b.platform_fee, b.platform_fee_status, b.barber_payout_amount, b.total_amount, b.booking_status, b.is_paid_booking,
              b.notes, b.cancelled_at, b.cancelled_by, b.created_at,
              b.deleted_at, b.deleted_by, b.delete_reason,
              b.paypal_refund_id, b.refund_amount, b.refunded_at, b.refund_reason,
              biz.name AS shop_name
       FROM bookings b
       LEFT JOIN businesses biz ON biz.id = b.business_id`;

  router.get("/api/admin/bookings/:id", guard, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const scope = req.bookingsAdminScope || { all: true };
      const tenantSql = scope.all ? "" : " AND b.business_id = $2 ";
      const params = scope.all ? [id] : [id, scope.businessId];

      const r = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B}${tenantSql} LIMIT 1`,
        params,
      );
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      return res.json({ ok: true, booking });
    } catch (e) {
      console.error("[booking] admin detail failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not load booking" });
    }
  });

  /**
   * GET /api/bookings/:id
   * Role-aware single-booking detail used by mobile booking detail screen.
   * Access matrix:
   *   - super_admin / admin                → any booking
   *   - shop_owner                         → bookings where business_id matches their app_user.business_id
   *   - barber                             → bookings where barber_id matches their app_user.barber_id
   *   - customer / regular user            → bookings where user_id = self OR customer_email = self.email
   * Returns 404 (not 403) when forbidden so we don't leak existence.
   */
  router.get("/api/bookings/:id", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const r = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`,
        [id],
      );
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) {
        console.log(
          `[booking] /api/bookings/:id forbidden id=${id.slice(0, 8)} role=${req.user?.role || "—"}`,
        );
        return res.status(404).json({ ok: false, message: "Booking not found" });
      }

      return res.json({ ok: true, booking });
    } catch (e) {
      console.error("[booking] /api/bookings/:id failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not load booking" });
    }
  });

  /**
   * DELETE /api/bookings/:id
   * Soft-delete for customers, barbers, shop owners, and platform admins.
   * Paid bookings with a PayPal capture cannot be removed until refund/cancel policy is satisfied.
   */
  router.delete("/api/bookings/:id", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : "Removed from history";

      const r = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`,
        [id],
      );
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const forceAdmin = isPlatformBookingOpsJwt(req.user);
      const assessment = assessBookingRemoval(booking, { forceAdmin });
      if (!assessment.allowed) {
        return res.status(409).json({
          ok: false,
          code: assessment.code || "cannot_delete",
          message: assessment.message || "This booking cannot be removed.",
        });
      }

      const actorId = actor.userId || null;
      const actorRole = actor.role || "customer";

      const upd = await dbQuery(
        `UPDATE bookings SET
           deleted_at = NOW(),
           deleted_by = $2,
           delete_reason = $3,
           booking_status = 'cancelled',
           is_paid_booking = false,
           cancelled_at = COALESCE(cancelled_at, NOW()),
           cancelled_by = COALESCE(cancelled_by, $4)
         WHERE id = $1::uuid AND deleted_at IS NULL
         RETURNING id, deleted_at, booking_status`,
        [id, actorId || actorRole, reason, actorRole],
      );
      if (!upd.rows?.length) {
        return res.status(404).json({ ok: false, message: "Booking not found or already removed" });
      }

      await recordStatusChange({
        bookingId: id,
        previousStatus: String(booking.booking_status || "").toLowerCase(),
        newStatus: "cancelled",
        actor: actor.actor,
        note: `[removed] ${reason}`,
      });

      void writeSecurityAudit({
        eventType: "booking_deleted",
        actorUserId: actorId,
        actorEmail: req.user?.email || null,
        req,
        metadata: {
          bookingId: id,
          action: "delete",
          reason,
          scope: forceAdmin ? "platform_admin" : actorRole,
          barberId: booking.barber_id,
          paymentStatus: booking.payment_status,
        },
      });

      void dispatchBookingPush({
        booking,
        kind: "booking_cancelled",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, deleted: true },
      });

      return res.json({ ok: true, message: "Booking removed from your history.", deleted: true });
    } catch (e) {
      console.error("[booking] DELETE /api/bookings/:id failed:", {
        bookingId: req.params?.id,
        actorRole: req.user?.role,
        actorId: req.user?.id,
        route: "DELETE /api/bookings/:id",
        error: e?.message || String(e),
        pgCode: e?.code,
        stack: e?.stack,
      });
      return res.status(500).json({ ok: false, message: "Could not remove booking" });
    }
  });

  /**
   * POST /api/bookings/:id/cancel
   * Thin wrapper around the status engine. Body: { reason?: string, blockSlot?: boolean }.
   * The slot is automatically released because the partial unique index
   * (`bookings_slot_unique_confirmed_paid`) only counts confirmed+paid rows;
   * a cancelled row drops out of the predicate. The optional `blockSlot` flag
   * is reserved for future admin "hold this slot offline" behavior — for now
   * we simply log it (no schema impact).
   */
  router.post("/api/bookings/:id/cancel", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 1000)
          : null;
      const blockSlot = req.body?.blockSlot === true;

      const r = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const currentStatus = String(booking.booking_status || "").toLowerCase();
      const transition = canTransition({
        from: currentStatus,
        to: "cancelled",
        role: actor.role,
        isPlatformSuper: actor.isPlatformSuper,
      });

      if (currentStatus === "cancelled") {
        return res.status(409).json({ ok: false, message: "This booking is already cancelled." });
      }
      if (currentStatus === "completed") {
        return res
          .status(409)
          .json({ ok: false, message: "Completed appointments can't be cancelled." });
      }
      if (!transition.ok) {
        return res
          .status(403)
          .json({ ok: false, message: "You can't cancel this appointment from its current state." });
      }

      // Only admin / shop_owner can request to "block the slot" — silently ignore for others.
      const slotRetained = blockSlot && (actor.role === "shop_owner" || actor.isPlatformSuper || actor.role === "admin" || actor.role === "super_admin");

      const upd = await dbQuery(
        `UPDATE bookings
         SET booking_status = 'cancelled',
             cancelled_at = NOW(),
             cancelled_by = $2,
             cancellation_reason = COALESCE($3, cancellation_reason)
         WHERE id = $1::uuid
         RETURNING id, booking_status, payment_status, cancelled_at, cancelled_by, cancellation_reason`,
        [id, actor.role, reason],
      );
      const updated = upd.rows?.[0];
      if (!updated) return res.status(500).json({ ok: false, message: "Cancel failed" });

      const noteParts = [];
      if (reason) noteParts.push(reason);
      if (slotRetained) noteParts.push("[slot held — admin may release manually]");
      await recordStatusChange({
        bookingId: id,
        previousStatus: currentStatus,
        newStatus: "cancelled",
        actor: actor.actor,
        note: noteParts.length ? noteParts.join(" ") : null,
      });

      // Best-effort push fanout. Never blocks; never throws to the caller.
      void dispatchBookingPush({
        booking,
        kind: "booking_cancelled",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, reason: reason || null },
      });

      const refundLine = "Refund review may be required depending on payment policy.";
      const baseMessage =
        actor.role === "customer"
          ? "Your appointment has been cancelled."
          : "Booking cancelled.";

      return res.json({
        ok: true,
        booking: updated,
        message: `${baseMessage} ${refundLine}`,
        refundReviewRequired: true,
      });
    } catch (e) {
      console.error("[booking] /api/bookings/:id/cancel failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Cancel failed" });
    }
  });

  /**
   * GET /api/bookings/:id/available-reschedule-slots
   * Mirrors `/api/app-bookings/available-slots` but is bound to a specific
   * booking — the booking's own row is excluded from the occupied list so the
   * customer can keep the same date and pick a different time, or even reselect
   * their current slot. Optional `?date=YYYY-MM-DD`; if omitted, defaults to
   * the booking's existing date so the screen has a sensible first paint.
   */
  router.get("/api/bookings/:id/available-reschedule-slots", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const sel = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = sel.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const requestedDate = String(req.query?.date || "").trim();
      let dateStr = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) dateStr = requestedDate;
      else if (booking.date) {
        dateStr =
          booking.date instanceof Date
            ? booking.date.toISOString().slice(0, 10)
            : String(booking.date).slice(0, 10);
      }
      if (!dateStr) {
        return res
          .status(400)
          .json({ ok: false, message: "Pass date=YYYY-MM-DD to load reschedule slots." });
      }

      const slotEngine = await import("./barberSlotEngine.js");
      const payload = await slotEngine.getAvailableSlotsForBarberDate(
        booking.barber_id,
        dateStr,
        booking.barber_name || "",
        { excludeBookingId: id },
      );

      return res.json({
        ok: true,
        date: dateStr,
        barberId: booking.barber_id,
        barberName: booking.barber_name,
        currentDate:
          booking.date instanceof Date
            ? booking.date.toISOString().slice(0, 10)
            : String(booking.date || "").slice(0, 10),
        currentTime: booking.time
          ? new Date(`1970-01-01T${String(booking.time)}`).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })
          : null,
        ...payload,
      });
    } catch (e) {
      console.error("[booking] /available-reschedule-slots failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not load slots" });
    }
  });

  /**
   * POST /api/bookings/:id/reschedule
   * Body: { date: "YYYY-MM-DD", time: "10:30 AM", note?: string }.
   *
   * - Validates ownership + role transition
   * - Re-runs validateBookingSlot with the booking excluded from occupancy
   * - Updates date/time atomically and stamps the rescheduled_* columns
   * - Records a status_history row containing the from/to slot
   * - Sends a refreshed confirmation email best-effort (failure logs only)
   */
  router.post("/api/bookings/:id/reschedule", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const newDate = String(req.body?.date || "").trim();
      const newTimeLabel = String(req.body?.time || "").trim();
      const note =
        typeof req.body?.note === "string" && req.body.note.trim()
          ? req.body.note.trim().slice(0, 1000)
          : null;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        return res.status(400).json({ ok: false, message: "date must be YYYY-MM-DD." });
      }
      if (!newTimeLabel) {
        return res.status(400).json({ ok: false, message: "time is required (e.g. '10:30 AM')." });
      }

      const sel = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = sel.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const currentStatus = String(booking.booking_status || "").toLowerCase();
      const targetStatus = "confirmed";
      const transition = canTransition({
        from: currentStatus,
        to: targetStatus,
        role: actor.role,
        isPlatformSuper: actor.isPlatformSuper,
      });
      // Customers in `confirmed` need an explicit lane: confirmed → confirmed is a self-loop.
      // Treat reschedule as allowed when either canTransition({to:'confirmed'}) succeeds OR
      // canTransition({to:'rescheduled'}) succeeds (their reschedule entry point), since the
      // resulting row is `confirmed` after the new slot is locked in.
      const reschedTransition = canTransition({
        from: currentStatus,
        to: "rescheduled",
        role: actor.role,
        isPlatformSuper: actor.isPlatformSuper,
      });
      if (!transition.ok && !reschedTransition.ok) {
        return res.status(403).json({
          ok: false,
          message: "You can't reschedule this appointment from its current state.",
        });
      }
      if (currentStatus === "completed" || currentStatus === "cancelled") {
        return res
          .status(409)
          .json({ ok: false, message: "This appointment can't be rescheduled." });
      }

      const slotEngine = await import("./barberSlotEngine.js");
      const slotCheck = await slotEngine.validateBookingSlot(
        booking.barber_id,
        newDate,
        newTimeLabel,
        booking.barber_name || "",
        { excludeBookingId: id },
      );
      if (!slotCheck.ok) {
        return res.status(409).json({
          ok: false,
          error: slotCheck.code || "slot_unavailable",
          message: slotCheck.message || "That time is not available.",
        });
      }
      const newTimeSql = slotCheck.timeSql;

      const oldDateStr =
        booking.date instanceof Date
          ? booking.date.toISOString().slice(0, 10)
          : String(booking.date || "").slice(0, 10);
      const oldTimeSql = String(booking.time || "");

      let upd;
      try {
        upd = await dbQuery(
          `UPDATE bookings
           SET date = $2::date,
               time = $3::time,
               booking_status = 'confirmed',
               rescheduled_from_date = COALESCE(rescheduled_from_date, $4::date),
               rescheduled_from_time = COALESCE(rescheduled_from_time, $5::time),
               rescheduled_to_date = $2::date,
               rescheduled_to_time = $3::time,
               rescheduled_by = $6,
               rescheduled_at = NOW()
           WHERE id = $1::uuid
           RETURNING id, date::text AS date, to_char(time, 'HH12:MI AM') AS time,
                     booking_status, payment_status,
                     rescheduled_from_date, rescheduled_from_time,
                     rescheduled_to_date, rescheduled_to_time,
                     rescheduled_by, rescheduled_at`,
          [id, newDate, newTimeSql, oldDateStr || null, oldTimeSql || null, actor.role],
        );
      } catch (sqlErr) {
        if (sqlErr?.code === "23505") {
          return res.status(409).json({
            ok: false,
            error: "slot_taken",
            message: "That time was just booked — pick another slot.",
          });
        }
        throw sqlErr;
      }
      const updated = upd.rows?.[0];
      if (!updated) return res.status(500).json({ ok: false, message: "Reschedule failed" });

      const oldLabel = `${oldDateStr || "—"} ${
        oldTimeSql
          ? new Date(`1970-01-01T${oldTimeSql}`).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })
          : ""
      }`.trim();
      const newLabel = `${newDate} ${newTimeLabel}`.trim();

      await recordStatusChange({
        bookingId: id,
        previousStatus: currentStatus,
        newStatus: "confirmed",
        actor: actor.actor,
        note: note
          ? `Rescheduled from ${oldLabel} to ${newLabel}. ${note}`
          : `Rescheduled from ${oldLabel} to ${newLabel}.`,
      });

      // Best-effort push fanout — uses the *new* date/time in the body.
      void dispatchBookingPush({
        booking: { ...booking, date: newDate, time: newTimeLabel },
        kind: "booking_rescheduled",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, fromLabel: oldLabel, toLabel: newLabel },
      });

      // Best-effort confirmation email — logs warning but never blocks the save.
      if (typeof sendBookingEmail === "function") {
        const email = String(booking.customer_email || "").trim();
        const isInternal =
          /@ifcdc\.local$/i.test(email) || /^pending\+/i.test(email);
        if (email && !isInternal) {
          try {
            await sendBookingEmail({
              name: booking.customer_name || "Guest",
              email,
              service: booking.service || booking.style_title || "Appointment",
              serviceDuration: Number(booking.service_duration_minutes) || undefined,
              date: newDate,
              time: newTimeLabel,
              barberName: booking.barber_name || "",
              language: undefined,
              ...bookingEmailPayloadFromRow(booking),
            });
            console.log(`[reschedule] confirmation email sent to ${email} for ${id.slice(0, 8)}`);
          } catch (emailErr) {
            console.warn(
              `[reschedule] confirmation email failed for ${id.slice(0, 8)}:`,
              emailErr?.message || emailErr,
            );
          }
        }
      }

      return res.json({
        ok: true,
        booking: updated,
        message: `Appointment moved to ${newLabel}.`,
      });
    } catch (e) {
      console.error("[booking] /reschedule failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Reschedule failed" });
    }
  });

  /**
   * PUT /api/bookings/:id/status
   * Universal role-aware status mutation. Body: { status, note? }.
   * - Validates the transition via the shared engine
   * - Refuses self-loops and forbidden role/state combinations
   * - Records a row in booking_status_history
   * - Stamps cancelled_at/cancelled_by when transitioning to 'cancelled'
   */
  router.put("/api/bookings/:id/status", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const target = String(req.body?.status || "").trim().toLowerCase();
      if (!isValidStatus(target)) {
        return res.status(400).json({
          ok: false,
          message: `Status must be one of: ${BOOKING_STATUSES.join(", ")}`,
        });
      }

      const note =
        typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim() : null;

      const r = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const currentStatus = String(booking.booking_status || "").toLowerCase();
      const transition = canTransition({
        from: currentStatus,
        to: target,
        role: actor.role,
        isPlatformSuper: actor.isPlatformSuper,
      });

      if (!transition.ok) {
        const reasons = {
          no_change: "Booking is already in that status.",
          invalid_target_status: "That status is not recognized.",
          missing_current_status: "Current booking status is missing.",
          transition_not_allowed: `${STATUS_LABELS[currentStatus] || currentStatus} → ${STATUS_LABELS[target] || target} isn't allowed for your role.`,
          role_not_allowed: "You don't have permission to change this status.",
        };
        return res.status(409).json({
          ok: false,
          error: transition.reason,
          message: reasons[transition.reason] || "That status change isn't allowed right now.",
        });
      }

      const isCancellation = target === "cancelled";
      const upd = await dbQuery(
        `UPDATE bookings
         SET booking_status = $2,
             cancelled_at = CASE WHEN $3::boolean THEN NOW() ELSE cancelled_at END,
             cancelled_by = CASE WHEN $3::boolean THEN $4 ELSE cancelled_by END
         WHERE id = $1::uuid
         RETURNING id, booking_status, payment_status, cancelled_at, cancelled_by`,
        [id, target, isCancellation, isCancellation ? actor.role : null],
      );
      const updated = upd.rows?.[0];
      if (!updated) return res.status(500).json({ ok: false, message: "Status update failed" });

      await recordStatusChange({
        bookingId: id,
        previousStatus: currentStatus,
        newStatus: target,
        actor: actor.actor,
        note: transition.override
          ? note
            ? `[override] ${note}`
            : "[override] Status set by elevated role"
          : note,
      });

      // Best-effort push fanout. Cancellations and reschedules use their own
      // dedicated kinds; everything else surfaces as a status update.
      const pushKind =
        target === "cancelled"
          ? "booking_cancelled"
          : target === "rescheduled"
            ? "booking_rescheduled"
            : "booking_status_update";
      void dispatchBookingPush({
        booking,
        kind: pushKind,
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, status: target, previousStatus: currentStatus },
      });

      const verb =
        target === "checked_in"
          ? "checked in"
          : target === "in_progress"
            ? "started"
            : target === "completed"
              ? "marked complete"
              : target === "no_show"
                ? "marked no-show"
                : target === "rescheduled"
                  ? "marked for reschedule"
                  : target === "cancelled"
                    ? "cancelled"
                    : `set to ${STATUS_LABELS[target] || target}`;

      return res.json({
        ok: true,
        booking: updated,
        message: `Booking ${verb}.`,
      });
    } catch (e) {
      console.error("[booking] PUT status failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Status update failed" });
    }
  });

  /**
   * GET /api/bookings/:id/status-history
   * Returns the timeline rows for a booking ordered oldest → newest.
   * Synthesizes a "Booked" row from bookings.created_at when no history rows
   * exist yet (covers legacy bookings).
   */
  router.get("/api/bookings/:id/status-history", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const r = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const timeline = await loadStatusTimeline(id, {
        created_at: booking.created_at,
        booking_status: booking.booking_status,
      });

      return res.json({ ok: true, history: timeline });
    } catch (e) {
      console.error("[booking] GET status-history failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not load history" });
    }
  });

  /**
   * POST /api/bookings/:id/status-history
   * Append a manual note to the timeline without changing the booking status.
   * Optional body: { note }. Useful for "customer ran late", "rebooked for Sat",
   * etc. Audited the same way as a status change.
   */
  router.post("/api/bookings/:id/status-history", requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const note =
        typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim() : null;
      if (!note) return res.status(400).json({ ok: false, message: "Note text is required" });

      const r = await dbQuery(`${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`, [id]);
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actor = await resolveBookingActor(req, booking);
      if (!actor) return res.status(404).json({ ok: false, message: "Booking not found" });

      const currentStatus = String(booking.booking_status || "").toLowerCase();
      await recordStatusChange({
        bookingId: id,
        previousStatus: currentStatus,
        newStatus: currentStatus,
        actor: actor.actor,
        note,
      });

      return res.json({ ok: true, message: "Note added." });
    } catch (e) {
      console.error("[booking] POST status-history failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not add note" });
    }
  });

  router.patch("/api/admin/bookings/:id", guard, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const action = String(req.body?.action || "").trim().toLowerCase();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });
      if (!action) return res.status(400).json({ ok: false, message: "action required" });

      const scope = req.bookingsAdminScope || { all: true };
      const tenantSql = scope.all ? "" : " AND business_id = $2 ";
      const scopeParams = scope.all ? [id] : [id, scope.businessId];
      const detailTenantSql = scope.all ? "" : " AND b.business_id = $2 ";

      const found = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B}${detailTenantSql} LIMIT 1`,
        scopeParams,
      );
      const booking = found.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const adminActor = {
        userId: req.user?.id ? String(req.user.id) : null,
        role: String(req.user?.role || "admin"),
        email: req.user?.email || null,
      };
      const previousStatus = String(booking.booking_status || "").toLowerCase();

      if (action === "complete") {
        const r = await dbQuery(
          `UPDATE bookings SET booking_status = 'completed'
           WHERE id = $1::uuid${tenantSql}
           RETURNING id, booking_status, payment_status`,
          scopeParams
        );
        if (r.rows?.[0]) {
          await recordStatusChange({
            bookingId: id,
            previousStatus,
            newStatus: "completed",
            actor: adminActor,
            note: req.body?.note || null,
          });
          void dispatchBookingPush({
            booking,
            kind: "booking_status_update",
            audience: ["customer", "barber", "shop_owners"],
            data: { bookingId: id, status: "completed" },
          });
        }
        return res.json({ ok: true, booking: r.rows[0], message: "Booking marked complete" });
      }

      if (action === "cancel") {
        const r = await dbQuery(
          `UPDATE bookings SET
             booking_status = 'cancelled',
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancelled_by = COALESCE(cancelled_by, $${scopeParams.length + 1})
           WHERE id = $1::uuid${tenantSql}
           RETURNING id, booking_status, payment_status, cancelled_at, cancelled_by`,
          [...scopeParams, adminActor.role]
        );
        if (r.rows?.[0]) {
          await recordStatusChange({
            bookingId: id,
            previousStatus,
            newStatus: "cancelled",
            actor: adminActor,
            note: req.body?.note || null,
          });
          void dispatchBookingPush({
            booking,
            kind: "booking_cancelled",
            audience: ["customer", "barber", "shop_owners"],
            data: { bookingId: id },
          });
        }
        return res.json({ ok: true, booking: r.rows[0], message: "Booking cancelled" });
      }

      if (action === "refund") {
        const r = await dbQuery(
          `UPDATE bookings SET
             payment_status = 'refunded',
             booking_status = 'cancelled',
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancelled_by = COALESCE(cancelled_by, $${scopeParams.length + 1})
           WHERE id = $1::uuid${tenantSql}
           RETURNING id, booking_status, payment_status, cancelled_at, cancelled_by`,
          [...scopeParams, adminActor.role]
        );
        if (r.rows?.[0]) {
          await recordStatusChange({
            bookingId: id,
            previousStatus,
            newStatus: "cancelled",
            actor: adminActor,
            note: req.body?.note ? `[refund] ${req.body.note}` : "[refund] Payment marked refunded",
          });
          void dispatchBookingPush({
            booking,
            kind: "booking_cancelled",
            audience: ["customer", "barber", "shop_owners"],
            data: { bookingId: id, refunded: true },
          });
        }
        return res.json({
          ok: true,
          booking: r.rows[0],
          message: "Refund recorded. Process PayPal settlement in the provider console if needed.",
        });
      }

      if (action === "receive_in_person") {
        const r = await dbQuery(
          `UPDATE bookings SET
             payment_status = 'paid',
             amount_paid = COALESCE(total_price, amount, 0),
             remaining_balance = 0,
             payment_type = COALESCE(NULLIF(btrim(payment_type), ''), 'full'),
             total_paid = COALESCE(total_price, amount, 0) + COALESCE(tip_amount, 0)
           WHERE id = $1::uuid
             AND payment_status IN ('pay_in_person', 'pending', 'pay_in_person_pending')${tenantSql}
           RETURNING id, booking_status, payment_status, amount_paid, remaining_balance`,
          scopeParams
        );
        if (!r.rows?.length) {
          return res.status(404).json({ ok: false, message: "No in-person booking found for this id" });
        }
        await recordStatusChange({
          bookingId: id,
          previousStatus,
          newStatus: previousStatus,
          actor: adminActor,
          note: "In-person payment received",
        });
        return res.json({ ok: true, booking: r.rows[0], message: "In-person payment recorded" });
      }

      return res.status(400).json({ ok: false, message: "Unknown action" });
    } catch (e) {
      console.error("[booking] admin patch failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Update failed" });
    }
  });

  router.post("/api/admin/bookings/:id/resend-confirmation", guard, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const scope = req.bookingsAdminScope || { all: true };
      const tenantSql = scope.all ? "" : " AND b.business_id = $2 ";
      const params = scope.all ? [id] : [id, scope.businessId];

      const r = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B}${tenantSql} LIMIT 1`,
        params,
      );
      const booking = r.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const email = String(booking.customer_email || "").trim();
      if (!email || /@ifcdc\.local$/i.test(email) || /^pending\+/i.test(email)) {
        return res.status(400).json({ ok: false, message: "No customer email on file for this booking" });
      }

      if (typeof sendBookingEmail !== "function") {
        return res.json({ ok: true, queued: true, message: "Confirmation queued for delivery" });
      }

      const dateStr = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : String(booking.date || "").slice(0, 10);
      const timeStr = String(booking.time || "").slice(0, 5);

      const mail = await sendBookingEmail({
        name: booking.customer_name || "Guest",
        email,
        barberName: booking.barber_name || "Barber",
        date: dateStr,
        time: timeStr,
        service: booking.style_title || booking.service || "Appointment",
        ...bookingEmailPayloadFromRow(booking),
      });

      if (mail?.error) {
        return res.status(502).json({ ok: false, message: "Confirmation could not be sent right now" });
      }

      return res.json({ ok: true, message: "Confirmation email sent" });
    } catch (e) {
      console.error("[booking] resend confirmation failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not resend confirmation" });
    }
  });

  router.delete("/api/admin/bookings/:id", platformOpsGuard, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : typeof req.query?.reason === "string" && req.query.reason.trim()
            ? req.query.reason.trim().slice(0, 500)
            : "Admin delete";

      const found = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`,
        [id],
      );
      const booking = found.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const actorId = req.user?.id ? String(req.user.id) : null;
      const actorRole = String(req.user?.role || "admin");

      const r = await dbQuery(
        `UPDATE bookings SET
           deleted_at = NOW(),
           deleted_by = $2,
           delete_reason = $3,
           booking_status = 'cancelled',
           is_paid_booking = false,
           cancelled_at = COALESCE(cancelled_at, NOW()),
           cancelled_by = COALESCE(cancelled_by, $4)
         WHERE id = $1::uuid AND deleted_at IS NULL
         RETURNING id, deleted_at, booking_status`,
        [id, actorId || actorRole, reason, actorRole],
      );
      if (!r.rows?.length) {
        return res.status(404).json({ ok: false, message: "Booking not found or already deleted" });
      }

      await recordStatusChange({
        bookingId: id,
        previousStatus: String(booking.booking_status || "").toLowerCase(),
        newStatus: "cancelled",
        actor: { userId: actorId, role: actorRole, email: req.user?.email || null },
        note: `[deleted] ${reason}`,
      });

      void writeSecurityAudit({
        eventType: "booking_deleted",
        actorUserId: actorId,
        actorEmail: req.user?.email || null,
        req,
        metadata: {
          bookingId: id,
          action: "delete",
          reason,
          barberId: booking.barber_id,
          paymentStatus: booking.payment_status,
        },
      });

      void dispatchBookingPush({
        booking,
        kind: "booking_cancelled",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, deleted: true },
      });

      return res.json({ ok: true, message: "Booking deleted permanently.", deleted: true });
    } catch (e) {
      console.error("[booking] admin delete failed:", {
        bookingId: req.params?.id,
        actorRole: req.user?.role,
        actorId: req.user?.id,
        adminScope: req.bookingsAdminScope?.via,
        route: "DELETE /api/admin/bookings/:id",
        error: e?.message || String(e),
        pgCode: e?.code,
        stack: e?.stack,
      });
      return res.status(500).json({ ok: false, message: "Could not delete booking" });
    }
  });

  router.post("/api/admin/bookings/:id/refund", platformOpsGuard, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "Booking id required" });

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : "Admin refund";

      const found = await dbQuery(
        `${BOOKING_DETAIL_SELECT} WHERE b.id = $1::uuid AND ${BOOKING_ACTIVE_B} LIMIT 1`,
        [id],
      );
      const booking = found.rows?.[0] || null;
      if (!booking) return res.status(404).json({ ok: false, message: "Booking not found" });

      const captureId = String(booking.paypal_capture_id || "").trim();
      if (!captureId) {
        return res.status(400).json({
          ok: false,
          error: "no_payment_transaction",
          message: "Refund unavailable: no payment transaction found.",
        });
      }

      if (!bookingHasRefundableCapture(booking)) {
        return res.status(400).json({
          ok: false,
          error: "not_refundable",
          message: "This booking has no refundable PayPal payment.",
        });
      }

      const charged = roundRefundMoney(
        Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid ?? 0),
      );
      const bodyAmount =
        req.body?.amount != null && Number.isFinite(Number(req.body.amount))
          ? roundRefundMoney(Number(req.body.amount))
          : null;
      const refundAmount = bodyAmount != null && bodyAmount > 0 ? bodyAmount : charged;
      if (refundAmount <= 0) {
        return res.status(400).json({
          ok: false,
          error: "invalid_amount",
          message: "Refund amount must be greater than zero.",
        });
      }

      await dbQuery(
        `UPDATE bookings SET payment_status = 'refund_pending' WHERE id = $1::uuid AND deleted_at IS NULL`,
        [id],
      );

      const paypalResult = await refundPayPalCapture(captureId, {
        amount: refundAmount,
        note: reason,
      });

      if (!paypalResult.ok) {
        await dbQuery(
          `UPDATE bookings SET payment_status = $2 WHERE id = $1::uuid AND deleted_at IS NULL`,
          [id, String(booking.payment_status || "paid_full")],
        );
        return res.status(502).json({
          ok: false,
          error: paypalResult.error || "paypal_refund_failed",
          message: paypalResult.message || "PayPal refund could not be completed.",
        });
      }

      const isPartial = charged > 0 && refundAmount + 0.02 < charged;
      const newPaymentStatus = isPartial ? "partially_refunded" : "refunded";
      const previousStatus = String(booking.booking_status || "").toLowerCase();
      const actorId = req.user?.id ? String(req.user.id) : null;
      const actorRole = String(req.user?.role || "admin");

      const r = await dbQuery(
        `UPDATE bookings SET
           payment_status = $2,
           paypal_refund_id = $3,
           refund_amount = $4,
           refunded_at = NOW(),
           refund_reason = $5,
           booking_status = 'cancelled',
           is_paid_booking = false,
           remaining_balance = 0,
           balance_due = 0,
           cancelled_at = COALESCE(cancelled_at, NOW()),
           cancelled_by = COALESCE(cancelled_by, $6)
         WHERE id = $1::uuid AND deleted_at IS NULL
         RETURNING id, payment_status, paypal_refund_id, refund_amount, refunded_at`,
        [
          id,
          newPaymentStatus,
          paypalResult.refundId || null,
          refundAmount,
          reason,
          actorRole,
        ],
      );

      if (!r.rows?.length) {
        return res.status(404).json({ ok: false, message: "Booking not found" });
      }

      await recordStatusChange({
        bookingId: id,
        previousStatus,
        newStatus: "cancelled",
        actor: { userId: actorId, role: actorRole, email: req.user?.email || null },
        note: `[refund] ${reason} · $${refundAmount.toFixed(2)}`,
      });

      void writeSecurityAudit({
        eventType: "payment_refund",
        actorUserId: actorId,
        actorEmail: req.user?.email || null,
        req,
        metadata: {
          bookingId: id,
          action: "refund",
          reason,
          refundId: paypalResult.refundId || null,
          captureId,
          amount: refundAmount,
          paymentStatus: newPaymentStatus,
        },
      });

      const dateStr =
        booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : String(booking.date || "").slice(0, 10);
      const timeStr = String(booking.time || "").slice(0, 5);
      void sendBookingRefundEmail({
        name: booking.customer_name || "Guest",
        email: booking.customer_email,
        service: booking.style_title || booking.service || "Appointment",
        date: dateStr,
        time: timeStr,
        barberName: booking.barber_name,
        refundAmount,
        refundId: paypalResult.refundId,
        reason,
        paymentStatus: newPaymentStatus,
      }).catch((e) => console.warn("[email] refund confirmation:", e?.message || e));

      void dispatchBookingPush({
        booking,
        kind: "booking_cancelled",
        audience: ["customer", "barber", "shop_owners"],
        data: { bookingId: id, refunded: true },
      });

      return res.json({
        ok: true,
        message: isPartial
          ? `Partial refund of $${refundAmount.toFixed(2)} processed via PayPal.`
          : `Refund of $${refundAmount.toFixed(2)} processed via PayPal.`,
        booking: r.rows[0],
        refundId: paypalResult.refundId,
        amount: refundAmount,
      });
    } catch (e) {
      console.error("[booking] admin refund failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: e?.message || "Refund failed" });
    }
  });

  /**
   * PATCH /api/admin/bookings/:id/mark-fully-paid
   * Clears remaining balance after in-person or other settlement (admin only via route prefix).
   */
  router.patch("/api/admin/bookings/:id/mark-fully-paid", guard, (_req, res) => {
    return res.status(410).json({
      error: "deposits_removed",
      message: "Deposit payments are no longer supported. All bookings require full payment at checkout.",
    });
  });

  /**
   * POST /api/bookings/:id/mark-paid
   * Staff action: admin/super_admin, barber (only their own bookings), or x-admin-key can mark a deposit booking as paid.
   * Sets remaining_balance=0, payment_status='paid', payment_type='full', total_paid=total_price+tip.
   */
  router.post("/api/bookings/:id/mark-paid", (_req, res) => {
    return res.status(410).json({
      error: "deposits_removed",
      message: "Deposit payments are no longer supported. All bookings require full payment at checkout.",
    });
  });

  // Admin stats compatible with existing UI (tenant-scoped for shop_owner)
  router.get("/api/admin/stats", guard, async (req, res) => {
    try {
      const scope = req.bookingsAdminScope || { all: true };
      const tenantWhere = scope.all
        ? ` WHERE ${BOOKING_ACTIVE} `
        : ` WHERE business_id = $1 AND ${BOOKING_ACTIVE} `;
      const tenantParams = scope.all ? [] : [scope.businessId];
      const r = await dbQuery(
        `SELECT id, customer_name AS name, customer_email AS customerEmail,
              phone,
              barber_name AS barber, barber_id AS barberId,
              business_id AS "businessId",
              service, style_title AS "styleTitle", date::text AS date, to_char(time, 'HH24:MI') AS time,
              amount::float AS price,
              total_price::float AS "totalPrice",
              platform_fee::float AS "platformFee",
              total_amount::float AS "totalAmount",
              deposit_amount::float AS "depositAmount",
              amount_paid::float AS "amountPaid",
              remaining_balance::float AS "remainingBalance",
              tip_amount::float AS "tipAmount",
              total_paid::float AS "totalPaid",
              payment_type AS "paymentType",
              payment_status AS "rawPaymentStatus",
              booking_status AS "bookingStatus",
              is_paid_booking AS "isPaidBooking",
              payment_method AS "paymentMethod",
              CASE
                WHEN payment_status IN ('paid', 'paid_full') THEN
                  CASE WHEN payment_provider = 'stripe' OR payment_method = 'card' THEN 'paid_card' ELSE 'paid_paypal' END
                WHEN payment_status = 'deposit_paid' THEN 'deposit_paypal'
                WHEN payment_status = 'balance_due' THEN 'balance_due'
                WHEN payment_status = 'unpaid' OR payment_status = 'failed' THEN 'unpaid'
                ELSE 'pay_in_person'
              END AS "paymentStatus",
              paypal_order_id AS "paypalOrderId",
              paypal_capture_id AS "paymentId",
              payment_provider AS "paymentProvider",
              created_at
       FROM bookings
       ${tenantWhere}
       ORDER BY created_at DESC
       LIMIT 500`,
        tenantParams
      );
      const rows = r.rows || [];
      let platformAgg = { platformFeesCollected: 0, paidBookingsCount: 0, confirmedBookingsCount: 0 };
      try {
        const ar = await dbQuery(
          `SELECT
           COALESCE(SUM(platform_fee) FILTER (WHERE is_paid_booking = true), 0)::float8 AS platform_fees_collected,
           COUNT(*) FILTER (WHERE is_paid_booking = true)::int AS paid_bookings,
           COUNT(*) FILTER (WHERE booking_status = 'confirmed')::int AS confirmed_bookings,
           COUNT(*)::int AS all_bookings
         FROM bookings
         ${tenantWhere}`,
          tenantParams,
        );
        const a = ar.rows?.[0] || {};
        platformAgg = {
          platformFeesCollected: Number(a.platform_fees_collected) || 0,
          paidBookingsCount: Number(a.paid_bookings) || 0,
          confirmedBookingsCount: Number(a.confirmed_bookings) || 0,
          allBookingsCount: Number(a.all_bookings) || 0,
        };
      } catch (e) {
        console.warn("[booking] platform aggregate:", e?.message || e);
      }
      const totalGross = rows.reduce((s, b) => s + Number(b.totalPrice ?? b.price ?? 0), 0);
      const totalCollected = rows.reduce((s, b) => s + Number(b.totalPaid ?? b.amountPaid ?? b.price ?? 0), 0);
      const outstandingBalanceAmount = rows.reduce((s, b) => s + Number(b.remainingBalance || 0), 0);
      const pendingPaymentsAmount = rows
        .filter((b) => b.paymentStatus === "pay_in_person")
        .reduce((s, b) => s + Number(b.totalPrice ?? b.price ?? 0), 0);

      return res.json({
        totalRevenue: totalGross,
        todayRevenue: 0,
        totalRevenuePlatform: totalCollected,
        totalBarberEarnings: 0,
        pendingPaymentsAmount,
        pendingPaymentsCount: rows.filter((b) => b.paymentStatus === "pay_in_person").length,
        outstandingBalanceAmount,
        outstandingBalanceCount: rows.filter(
          (b) =>
            Number(b.remainingBalance || 0) > 0.01 ||
            String(b.rawPaymentStatus || "").toLowerCase() === "balance_due",
        ).length,
        totalPlatformEarnings: totalCollected,
        platformFeesCollected: platformAgg.platformFeesCollected,
        paidBookingsCount: platformAgg.paidBookingsCount,
        confirmedBookingsCount: platformAgg.confirmedBookingsCount,
        allBookingsCount: platformAgg.allBookingsCount,
        totalBookings: rows.length,
        bookings: rows,
        todayYmd: null,
        topServices: {},
        avgBooking: rows.length ? totalGross / rows.length : 0,
        highestPayment: rows.length ? Math.max(...rows.map((b) => Number(b.totalPrice ?? b.price ?? 0))) : 0,
        lastPaymentAt: rows[0]?.created_at || null,
      });
    } catch (e) {
      console.error("[booking] admin stats failed:", e?.stack || e);
      return res.status(500).json({ error: "stats_failed", message: e?.message || String(e) });
    }
  });

  /**
   * POST /api/book
   * Requires PayPal capture already completed:
   * - paypalOrderId
   * - paymentId (paypalCaptureId)
   * Server verifies capture before insert.
   */
  router.post("/api/book", async (req, res) => {
    try {
      const body = req.body || {};
      const voiceChannel = String(body.channel || "").toLowerCase().trim() === "aura_voice";
      const voiceSecretExpected = String(process.env.VOICE_BOOKING_SECRET || "").trim();
      const voiceSecretHeader = String(req.get("x-voice-booking-secret") || "").trim();
      if (voiceChannel) {
        if (!voiceSecretExpected || voiceSecretHeader !== voiceSecretExpected) {
          return res.status(401).json({
            error: "unauthorized_voice_booking",
            message: "Set VOICE_BOOKING_SECRET and send matching x-voice-booking-secret header",
          });
        }
        try {
          const out = await insertAuraVoiceBookingRow(body, sendBookingEmail);
          if (!out.ok) {
            return res.status(out.status || 400).json({ error: out.error, message: out.message });
          }
          return res.json({
            ok: true,
            channel: "aura_voice",
            booking: out.booking,
            emailSent: out.emailSent,
            emailError: out.emailError,
            deduped: Boolean(out.deduped),
          });
        } catch (e) {
          console.error("[booking] aura_voice /api/book:", e?.stack || e);
          return res.status(500).json({ error: "booking_failed", message: e?.message || String(e) });
        }
      }

      const customerName = String(body.name || "").trim();
      const customerEmail = String(body.email || "").trim();
      const barberName = String(body.barber || body.barberName || "").trim();
      const dateStr = String(body.date || "").trim();
      const timeStr = String(body.time || "").trim();
      const paypalOrderId = String(body.paypalOrderId || "").trim();
      const paypalCaptureId = String(body.paymentId || body.paypalCaptureId || "").trim();
      const styleId = String(body.styleId || "").trim();

      const resolved = await resolveBarberIdentity(
        dbQuery,
        body.barberId ?? body.barber ?? body.barberUuid ?? body.barber_uuid,
        barberName,
      );
      if (!resolved) {
        return res.status(400).json({ error: "barber_unresolved", message: BARBER_RESOLVE_MSG });
      }
      const barberId = await barberIdForTable(dbQuery, "bookings", resolved);
      if (barberId == null) {
        return res.status(400).json({ error: "barber_unresolved", message: BARBER_RESOLVE_MSG });
      }
      const confirmedBarberName = resolved.barberName || barberName;

      if (!customerName || !customerEmail || !dateStr || !timeStr) {
        return res.status(400).json({ error: "missing_fields", message: "Missing required booking fields" });
      }
      if (!isDeliverableCustomerEmail(customerEmail)) {
        return res.status(400).json({
          error: "invalid_email",
          message:
            "A valid customer email is required to send your IFCDC booking confirmation after payment.",
        });
      }
      if (!paypalOrderId || !paypalCaptureId) {
        return res.status(400).json({ error: "payment_required", message: "Payment required" });
      }
      if (!styleId) {
        return res.status(400).json({ error: "style_required", message: "Select a style before completing payment" });
      }

      const depositOpts = await loadBarberDepositPricingOpts(barberId);
      const paymentTypeRaw = normalizePaymentType(body, depositOpts);
      const quoted = await computeStyleBookingBreakdown({
        styleId,
        barberId,
        paymentType: paymentTypeRaw,
        body,
      });
      if (!quoted.ok) {
        return res.status(quoted.status || 400).json({ error: quoted.error, message: quoted.message });
      }

      const styleRow = await loadStyleRow(styleId);
      if (!styleRow || String(styleRow.id) !== quoted.styleId) {
        return res.status(400).json({ error: "style_not_found", message: "Style not found" });
      }

      const slotOk = await assertSlotWithinAvailability(barberId, dateStr, timeStr, confirmedBarberName);
      if (!slotOk.ok) {
        return res.status(400).json({ error: "slot_not_available", message: slotOk.message || "Time not available" });
      }

      const breakdown = enforcePlatformFeeOnBreakdown(quoted.breakdown, body, quoted.subscription_tier);
      const { totalPrice, depositAmount, serviceCharge, platformFee, totalAmount, tipAmount, paypalTotal, paymentType } =
        breakdown;
      const barberBookingFee = roundMoney2(BARBER_PLATFORM_FEE_USD);
      const barberPayoutStored = roundMoney2(Math.max(0, totalPrice - barberBookingFee));
      const serviceTitle = quoted.styleTitle || String(styleRow.title || "").trim() || "Style";
      const remainingBalance = roundMoney2(Math.max(0, totalPrice - serviceCharge));

      let clientId = null;
      try {
        clientId = await resolveOrCreateBarberClientId(barberId, customerName, customerEmail);
      } catch {
        /* optional */
      }

      console.log("[booking] verify capture", {
        paypalOrderId,
        paypalCaptureId,
        paypalTotal,
        paymentType,
        styleId,
      });
      const verify = await verifyPayPalCapture({
        paypalOrderId,
        paypalCaptureId,
        expectedAmount: paypalTotal,
      });
      if (!verify.ok) {
        console.error("[booking] payment verify failed:", verify.error, verify.message);
        return res.status(400).json({ error: verify.error, message: verify.message });
      }

      const capturedAmt = extractCaptureAmount(verify.order);
      const settlement = computeSettlementFromCapture({
        servicePrice: totalPrice,
        depositAmount,
        platformFee: barberBookingFee,
        tipAmount,
        capturedUsd: capturedAmt?.value ?? paypalTotal,
        captureId: paypalCaptureId,
        paymentProvider: "paypal",
      });
      if (!settlement.ok) {
        const failStatus =
          settlement.paymentStatus === PAYMENT_STATUS.PAYMENT_MISMATCH
            ? PAYMENT_STATUS.PAYMENT_MISMATCH
            : PAYMENT_STATUS.PAYMENT_FAILED;
        return res.status(400).json({
          error: settlement.error || failStatus,
          message: settlement.message || "Payment amount does not match booking total.",
        });
      }
      const paymentStatus = settlement.paymentStatus;
      const settledRemaining = settlement.balanceDue;
      const settledPaid = settlement.amountPaid;

      const userId = getAuthUserId(req);
      const styleImageUrl = quoted.styleImageUrl ?? (styleRow.image_url ? String(styleRow.image_url) : null);
      const tenantBizIdForInsert = await resolveBusinessIdForBarber(barberId);
      const bookingsColType = await getTableBarberIdType(dbQuery, "bookings");
      logDbInsertDebug({
        route: req.path,
        table: "bookings",
        barberId: body.barberId,
        barber_id: body.barber_id,
        resolvedBarberDbId: resolvedBarberDbIdOnly(resolved),
        insertBarberId: barberId,
        bookingsColType,
        payload: body,
      });
      if (bookingsColType !== "uuid") {
        assertNotUuidForBigintBarberId(barberId, "bookings", req.path);
      }

      let payBookingLang = "en";
      try {
        const st = await loadBarberSettingsRow(barberId);
        payBookingLang = st?.language || "en";
      } catch {
        /* default en */
      }

      const insert = await dbQuery(
        `INSERT INTO bookings
         (user_id, customer_name, customer_email, barber_name, barber_id, client_id, service, date, time, amount,
          service_price, total_price, deposit_amount, amount_paid, amount_charged, balance_due, remaining_balance,
          payment_type, payment_status, payment_method, payment_provider, paypal_order_id, paypal_capture_id,
          style_id, style_title, style_image_url, tip_amount, total_paid,
          platform_fee, total_amount, booking_status, is_paid_booking,
          deposit_required, deposit_status, deposit_payment_link, deposit_transaction_id, deposit_paypal_order_id,
          platform_fee_status, barber_payout_amount, barber_fee_billed, business_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
                 $29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
         ON CONFLICT (paypal_capture_id) DO NOTHING
         RETURNING id, created_at`,
        [
          userId,
          customerName,
          customerEmail,
          confirmedBarberName || null,
          barberId,
          clientId,
          serviceTitle,
          dateStr,
          timeStr,
          totalPrice,
          totalPrice,
          totalPrice,
          depositAmount,
          settledPaid,
          settledPaid,
          settledRemaining,
          settledRemaining,
          settlement.paymentType,
          paymentStatus,
          settlement.paymentMethod,
          "paypal",
          paypalOrderId,
          paypalCaptureId,
          styleRow.id,
          serviceTitle,
          styleImageUrl,
          tipAmount,
          settledPaid,
          barberBookingFee,
          totalAmount,
          "confirmed",
          settlement.isPaidBooking,
          false,
          "not_required",
          null,
          null,
          null,
          "pending",
          barberPayoutStored,
          false,
          tenantBizIdForInsert,
        ]
      );

      if (!insert.rows?.length) {
        const existing = await dbQuery(
          `SELECT id, user_id, customer_name, customer_email, barber_name, barber_id, service, date, time, amount,
                  total_price, deposit_amount, amount_paid, amount_charged, remaining_balance, balance_due,
                  tip_amount, total_paid, platform_fee, total_amount,
                  payment_type, payment_status, payment_method, payment_provider, paypal_order_id, paypal_capture_id,
                  style_id, style_title, style_image_url, created_at
           FROM bookings
           WHERE paypal_capture_id = $1
           LIMIT 1`,
          [paypalCaptureId]
        );
        const row = existing.rows?.[0] || null;
        let emailSent = false;
        let emailError = null;
        const dedupeEmail = row.customer_email || customerEmail;
        if (
          row &&
          sendBookingEmail &&
          isDeliverableCustomerEmail(dedupeEmail) &&
          shouldSendPaidConfirmationEmail(row.payment_status)
        ) {
          try {
            const r = await sendBookingEmail({
              name: row.customer_name || customerName,
              email: dedupeEmail,
              barberName: row.barber_name || barberName,
              date: String(row.date ?? dateStr),
              time: String(row.time ?? timeStr),
              service: row.service || serviceTitle,
              serviceDuration: undefined,
              language: payBookingLang,
              bookingId: row.id,
              paymentStatus: PAYMENT_STATUS.PAID_IN_FULL,
              ...bookingEmailPayloadFromRow(row),
            });
            emailSent = Boolean(r?.success ?? r?.messageId);
            emailError = r?.error || null;
          } catch (e) {
            emailSent = false;
            emailError = e?.message || String(e);
            console.error("[booking] dedupe confirmation email FAILED:", emailError, {
              bookingId: row.id,
              email: dedupeEmail,
            });
          }
        }
        return res.json({ ok: true, booking: row, deduped: true, emailSent, emailError });
      }

      const bookingId = insert.rows[0].id;
      console.log("[booking] saved", { bookingId, paypalCaptureId, paymentType, paymentStatus, styleId });

      let emailSent = false;
      let emailError = null;
      try {
        const r = await sendBookingEmail?.({
          name: customerName,
          email: customerEmail,
          barberName,
          date: dateStr,
          time: timeStr,
          service: serviceTitle,
          serviceDuration: undefined,
          language: payBookingLang,
          bookingId,
          paymentStatus: PAYMENT_STATUS.PAID_IN_FULL,
          ...bookingEmailPayloadFromRow({
            service_price: totalPrice,
            total_price: totalPrice,
            deposit_amount: 0,
            amount_paid: settledPaid,
            amount_charged: settledPaid,
            balance_due: 0,
            remaining_balance: 0,
            platform_fee: barberBookingFee,
            tip_amount: tipAmount,
            payment_status: paymentStatus,
            paypal_capture_id: paypalCaptureId,
            payment_provider: "paypal",
            payment_method: settlement.paymentMethod,
          }),
        });
        emailSent = Boolean(r?.success ?? r?.messageId);
        emailError = r?.error || null;
        if (emailSent) {
          console.log("[booking-email] SENT OK (POST /api/book)", {
            bookingId,
            to: customerEmail,
            messageId: r?.messageId,
          });
        }
      } catch (e) {
        emailSent = false;
        emailError = e?.message || String(e);
        console.error("[booking-email] FAILED (POST /api/book):", emailError, {
          bookingId,
          to: customerEmail,
        });
      }

      return res.json({
        ok: true,
        booking: {
          id: bookingId,
          barberId,
          barberName,
          service: serviceTitle,
          styleId: styleRow.id,
          styleTitle: serviceTitle,
          styleImageUrl,
          date: dateStr,
          time: timeStr,
          name: customerName,
          customerEmail,
          price: totalPrice,
          totalPrice,
          platformFee,
          totalAmount,
          depositAmount,
          amountPaid: serviceCharge,
          tipAmount,
          totalPaid: paypalTotal,
          remainingBalance,
          paymentType,
          paymentStatus: "paid_in_full",
          rawPaymentStatus: paymentStatus,
          bookingStatus: "confirmed",
          isPaidBooking: true,
          paypalOrderId,
          paymentId: paypalCaptureId,
          paymentProvider: "paypal",
        },
        emailSent,
        emailError,
      });
    } catch (e) {
      console.error("[booking] /api/book failed:", e?.stack || e);
      return res.status(500).json({ error: "booking_failed", message: e?.message || String(e) });
    }
  });

  return router;
}

