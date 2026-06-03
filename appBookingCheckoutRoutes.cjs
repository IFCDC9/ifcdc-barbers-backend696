/**
 * Mobile app booking checkout — Postgres + PayPal Orders v2.
 * POST /api/app-bookings/start | /finalize | GET /occupied-slots | GET /health
 */
const express = require("express");
const path = require("node:path");
const paypalSdk = require("@paypal/checkout-server-sdk");
const {
  resolveServiceForBooking,
  resolveBarberIdentity,
  scheduleBarberIdFromResolved,
  barberIdForTable,
  stripQuotes,
} = require("./bookingServicesCatalog.cjs");
const {
  BARBER_RESOLVE_MSG,
  isBarberIdentityDbError,
  logDbInsertDebug,
  assertNotUuidForBigintBarberId,
  resolvedBarberDbIdOnly,
  getTableBarberIdType,
  coerceBarberIdForTable,
  logBookingInsertSuccess,
} = require("./barberIdentity.cjs");
const { handlePublicBarberServicesGet, handlePublicBarbersListGet } = require("./bookingPublicHandlers.cjs");
const {
  DEFAULT_PLATFORM_FEE: SETTLEMENT_PLATFORM_FEE,
  resolvePlatformFeeUsd,
  extractPayPalCapturedUsd,
  computeSettlementFromCapture,
  bookingPaymentViewFromRow,
  isBookingPaymentSettled,
  shouldSendPaidConfirmationEmail,
  paymentStatusForEmailFromRow,
  settlementUpdateParams,
  PAYMENT_STATUS,
} = require("./bookingPaymentSettlement.cjs");
const {
  isPayPalLive,
  getPayPalEnvironmentMeta,
  getPayPalHealthDiagnostics,
  normalizePayPalEnvValue,
  getPayPalSecret,
} = require("./paypalEnv.cjs");

const router = express.Router();

const DEFAULT_HAIRCUT_USD = Number(process.env.APP_BOOKING_HAIRCUT_USD || 25);
const DEFAULT_PLATFORM_FEE = SETTLEMENT_PLATFORM_FEE;

let cachedBarbersIdType = null;
async function getBarbersIdColumnTypeCached() {
  if (cachedBarbersIdType) return cachedBarbersIdType;
  const mod = await import(path.join(__dirname, "barberScheduleMigrations.js"));
  cachedBarbersIdType = await mod.getBarbersIdColumnType();
  return cachedBarbersIdType;
}

function bookingStartErrorResponse(res, err) {
  if (isBarberIdentityDbError(err)) {
    return res.status(400).json({
      success: false,
      error: "barber_unresolved",
      message: BARBER_RESOLVE_MSG,
    });
  }
  return null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatPayPalFailure(err) {
  if (err == null) return { message: "Unknown PayPal error", code: "paypal_error", httpStatus: 502, body: null };
  const raw = err instanceof Error ? err.message : String(err);
  const fromSdk = Number(err?.statusCode ?? err?.status ?? 0) || null;
  try {
    const j = JSON.parse(raw);
    const paypalCode = j.error || j.name;
    const desc = j.error_description || j.message || j.details?.[0]?.description || raw;
    if (paypalCode === "invalid_client") {
      return {
        code: "invalid_client",
        message:
          "PayPal rejected client credentials (invalid_client). Use PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET from the SAME app.",
        httpStatus: fromSdk && fromSdk >= 400 ? fromSdk : 401,
        body: j,
      };
    }
    return {
      code: paypalCode || "paypal_error",
      message: String(desc),
      httpStatus: fromSdk && fromSdk >= 400 ? fromSdk : 502,
      body: j,
    };
  } catch {
    if (/invalid_client/i.test(raw)) {
      return {
        code: "invalid_client",
        message: "PayPal invalid_client: client ID and secret must match PAYPAL_ENV (sandbox vs live).",
        httpStatus: fromSdk && fromSdk >= 400 ? fromSdk : 401,
        body: { raw: raw.slice(0, 2000) },
      };
    }
    return {
      code: err?.code || "paypal_error",
      message: raw,
      httpStatus: fromSdk && fromSdk >= 400 ? fromSdk : 502,
      body: { raw: raw.slice(0, 2000) },
    };
  }
}

function extractPayPalErrorFull(err) {
  const formatted = formatPayPalFailure(err);
  return {
    code: formatted.code,
    message: formatted.message,
    httpStatus: formatted.httpStatus,
    statusCode: err?.statusCode ?? err?.status ?? null,
    body: formatted.body,
    stack: err instanceof Error ? err.stack : undefined,
  };
}

function assertValidPayPalAmount(label, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error(`Invalid PayPal ${label}: ${value}`);
    err.code = "invalid_amount";
    throw err;
  }
  return round2(n);
}

function extractCaptureIdFromOrder(capture) {
  const units = Array.isArray(capture?.purchase_units) ? capture.purchase_units : [];
  for (const pu of units) {
    const caps = pu?.payments?.captures;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      if (c?.id != null && String(c.id).trim() !== "") return String(c.id).trim();
    }
  }
  return null;
}

function getPayPalHttpClient() {
  const clientId = normalizePayPalEnvValue(process.env.PAYPAL_CLIENT_ID);
  const clientSecret = getPayPalSecret();
  if (!clientId || !clientSecret) {
    const err = new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
    err.code = "paypal_config";
    throw err;
  }
  const env = isPayPalLive()
    ? new paypalSdk.core.LiveEnvironment(clientId, clientSecret)
    : new paypalSdk.core.SandboxEnvironment(clientId, clientSecret);
  return new paypalSdk.core.PayPalHttpClient(env);
}

function parseTimeLabelToSqlTime(label) {
  const s = String(label || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

function ymd(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Resolve mobile demo labels ("Today", "Tomorrow", weekday) to YYYY-MM-DD in local TZ. */
function resolveDateLabelToYmd(label) {
  const t = stripQuotes(label);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const low = t.toLowerCase();
  if (low === "today") return ymd(base);
  if (low === "tomorrow") {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const want = days.indexOf(low);
  if (want < 0) return null;
  const cur = base.getDay();
  let add = (want - cur + 7) % 7;
  const d = new Date(base);
  d.setDate(d.getDate() + add);
  return ymd(d);
}

async function loadDb() {
  const { dbQuery } = await import(path.join(__dirname, "db.js"));
  return { dbQuery };
}

async function loadSlotEngine() {
  return import(path.join(__dirname, "barberSlotEngine.js"));
}

async function loadTier() {
  const mod = await import(path.join(__dirname, "subscriptionTier.js"));
  return resolvePlatformFeeUsd(mod.platformFeeUsdForTier(null));
}

router.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const paypal = await getPayPalHealthDiagnostics();
    if (!paypal.alignment?.ok) {
      console.warn("[paypal] ENV MISALIGNMENT:", paypal.alignment?.message || "OAuth failed");
    } else {
      console.log("[paypal] OAuth OK —", paypal.environment, "token generation succeeded");
    }
    res.json({
      ok: Boolean(paypal.alignment?.ok),
      service: "ifcdc-barbers-backend696",
      paypal,
    });
  } catch (e) {
    console.error("[paypal] health diagnostics failed:", e?.message || e);
    res.status(503).json({
      ok: false,
      paypal: { ...getPayPalEnvironmentMeta(), oauth: { ok: false, error: e?.message || String(e) } },
    });
  }
});

/** Bookable barbers from Postgres (source of truth for checkout). */
router.get("/barbers", async (req, res) => {
  try {
    const { dbQuery } = await loadDb();
    return await handlePublicBarbersListGet(req, res, dbQuery);
  } catch (e) {
    console.error("[app-bookings] barbers:", e?.message || e);
    res.status(500).json({ ok: false, error: "barbers_failed", message: e?.message || String(e) });
  }
});

router.get("/services", async (req, res) => {
  try {
    const { dbQuery } = await loadDb();
    return await handlePublicBarberServicesGet(req, res, dbQuery);
  } catch (e) {
    console.error("[app-bookings] services:", e?.message || e);
    return res.status(500).json({ ok: false, error: "services_failed", message: e?.message || String(e) });
  }
});

router.get("/start", (_req, res) =>
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      ok: false,
      error: "method_not_allowed",
      message:
        "Use POST /api/app-bookings/start with JSON (barberName, dateLabel, timeLabel, redirectUri).",
    }),
);

async function resolveAvailableSlotsQuery(req) {
  const barberName = stripQuotes(req.query.barberName);
  const dateLabel = stripQuotes(req.query.dateLabel);
  const dateRaw = stripQuotes(req.query.date);
  const barberIdRaw = stripQuotes(req.query.barberId ?? req.query.barberUuid);

  let dateStr = null;
  if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) dateStr = dateRaw;
  else if (dateLabel) dateStr = resolveDateLabelToYmd(dateLabel);

  const { dbQuery } = await loadDb();
  const barbersIdType = await getBarbersIdColumnTypeCached();
  const resolved = await resolveBarberIdentity(dbQuery, barberIdRaw || null, barberName);
  if (!resolved) {
    return { dateStr, barberId: null, barberName, barberRow: null, resolved: null };
  }

  const scheduleId = scheduleBarberIdFromResolved(resolved, barbersIdType);
  return {
    dateStr,
    barberId: scheduleId,
    barberName: resolved.barberName,
    barberRow: resolved.barberRow,
    resolved,
  };
}

router.get("/available-slots", async (req, res) => {
  try {
    const { dateStr, barberId, barberName, resolved } = await resolveAvailableSlotsQuery(req);
    if (!dateStr) {
      return res.status(400).json({ ok: false, error: "bad_date", message: "Pass date=YYYY-MM-DD or dateLabel=Today" });
    }
    if (!resolved && !barberName) {
      return res.status(400).json({ ok: false, error: "query_required", message: "barberId or barberName required" });
    }
    if (!resolved || barberId == null) {
      return res.status(400).json({
        ok: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }
    const slotEngine = await loadSlotEngine();
    const payload = await slotEngine.getAvailableSlotsForBarberDate(barberId, dateStr, resolved.barberName);
    return res.json({ ok: true, date: dateStr, barberId, ...payload });
  } catch (e) {
    console.error("[app-bookings] available-slots:", e?.stack || e);
    const barberErr = bookingStartErrorResponse(res, e);
    if (barberErr) return barberErr;
    return res.status(500).json({ ok: false, error: "server_error", message: "Unable to load available times." });
  }
});

router.get("/occupied-slots", async (req, res) => {
  try {
    const barberName = stripQuotes(req.query.barberName);
    const dateLabel = stripQuotes(req.query.dateLabel);
    const barberIdRaw = stripQuotes(req.query.barberId ?? req.query.barberUuid);
    if ((!barberName && !barberIdRaw) || !dateLabel) {
      return res.status(400).json({ ok: false, error: "query_required", message: "barberId or barberName and dateLabel required" });
    }
    const dateStr = resolveDateLabelToYmd(dateLabel);
    if (!dateStr) {
      return res.status(400).json({ ok: false, error: "bad_date_label", message: "Unrecognized dateLabel" });
    }
    const { dbQuery } = await loadDb();
    const barbersIdType = await getBarbersIdColumnTypeCached();
    const resolved = await resolveBarberIdentity(dbQuery, barberIdRaw || null, barberName);
    if (!resolved) {
      return res.json({ ok: true, times: [] });
    }
    const scheduleId = scheduleBarberIdFromResolved(resolved, barbersIdType);
    const slotEngine = await loadSlotEngine();
    const times = await slotEngine.loadOccupiedSlotLabels(scheduleId, dateStr, resolved.barberName);
    return res.json({ ok: true, times });
  } catch (e) {
    console.error("[app-bookings] occupied-slots:", e?.stack || e);
    const barberErr = bookingStartErrorResponse(res, e);
    if (barberErr) return barberErr;
    return res.status(500).json({ ok: false, error: "server_error", message: "Unable to load occupied slots." });
  }
});

router.post("/start", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("[app-bookings] PAYMENT REQUEST BODY:", {
      barberName: body.barberName,
      barberId: body.barberId ?? body.barber_id,
      serviceId: body.serviceId ?? body.service_id,
      dateLabel: body.dateLabel,
      timeLabel: body.timeLabel,
      redirectUri: body.redirectUri,
      depositAmount: body.depositAmount,
    });
    console.log("[app-bookings] PAYPAL ENV:", getPayPalEnvironmentMeta());
    const barberName = stripQuotes(body.barberName);
    const barberIdRaw = stripQuotes(body.barberId ?? body.barber_id);
    const barberUuidRaw = stripQuotes(body.barberUuid ?? body.barber_uuid);
    const barberLookupId = barberUuidRaw || barberIdRaw;

    const { dbQuery } = await loadDb();

    // Resolve barber identity FIRST — before slots, services, PayPal, or booking insert.
    const resolved = await resolveBarberIdentity(dbQuery, barberLookupId || barberName || null, barberName);
    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }

    const bookingsColType = await getTableBarberIdType(dbQuery, "bookings");
    const resolvedBarberDbId = resolvedBarberDbIdOnly(resolved);
    const insertBarberId = await barberIdForTable(dbQuery, "bookings", resolved);
    const serviceBarberKey = await barberIdForTable(dbQuery, "barber_services", resolved);
    const scheduleId = await coerceBarberIdForTable(
      dbQuery,
      "barber_settings",
      resolved.barberUuid ?? resolved.barberDbId,
      resolved.barberName,
    );

    logDbInsertDebug({
      route: req.path,
      barberId: barberIdRaw,
      barber_id: body.barber_id,
      barberUuid: barberUuidRaw,
      resolvedBarberDbId,
      insertBarberId,
      serviceBarberKey,
      scheduleId,
      bookingsColType,
      payload: body,
    });

    if (insertBarberId == null) {
      return res.status(400).json({
        success: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }
    if (bookingsColType !== "uuid") {
      assertNotUuidForBigintBarberId(insertBarberId, "bookings", req.path);
    }
    if (serviceBarberKey == null) {
      return res.status(400).json({
        success: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }
    if (scheduleId == null) {
      return res.status(400).json({
        success: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }

    console.log("[checkout] barber identity resolved", {
      barberName: resolved.barberName,
      resolvedBarberDbId,
      barberUuid: resolved.barberUuid,
      insertBarberId,
      serviceBarberKey,
      scheduleId,
      bookingsColType,
    });

    const dateLabel = stripQuotes(body.dateLabel);
    const timeLabel = stripQuotes(body.timeLabel);
    const redirectUri = stripQuotes(body.redirectUri);
    const cancelUri = stripQuotes(body.cancelUri);
    const customerName = stripQuotes(body.customerName) || "Mobile customer";
    const customerEmail = stripQuotes(body.customerEmail) || stripQuotes(process.env.APP_BOOKING_PLACEHOLDER_EMAIL) || "pending+app@ifcdc.local";
    const serviceNameRaw = stripQuotes(body.serviceName ?? body.service_name);
    const serviceIdRaw = body.serviceId ?? body.service_id;
    const confirmedBarberName = resolved.barberName;

    if ((!barberName && !barberLookupId) || !dateLabel || !timeLabel || !redirectUri) {
      return res.status(400).json({
        success: false,
        error: "missing_fields",
        message: "barberName or barberId, dateLabel, timeLabel, and redirectUri are required",
      });
    }

    if (serviceIdRaw == null || String(serviceIdRaw).trim() === "") {
      return res.status(400).json({
        success: false,
        error: "service_required",
        message: "Select a service before checkout.",
      });
    }

    const dateStr = resolveDateLabelToYmd(dateLabel);
    if (!dateStr) {
      return res.status(400).json({
        success: false,
        error: "bad_datetime",
        message: "Could not parse dateLabel",
      });
    }

    const slotEngine = await loadSlotEngine();
    const slotCheck = await slotEngine.validateBookingSlot(scheduleId, dateStr, timeLabel, confirmedBarberName);
    if (!slotCheck.ok) {
      return res.status(409).json({
        success: false,
        error: slotCheck.code || "slot_unavailable",
        message: slotCheck.message || "That time is not available.",
      });
    }
    const timeSql = slotCheck.timeSql;

    const serviceRow = await resolveServiceForBooking(
      dbQuery,
      serviceBarberKey,
      serviceIdRaw,
      serviceNameRaw,
      confirmedBarberName,
    );
    if (!serviceRow) {
      return res.status(400).json({
        success: false,
        error: "unknown_service",
        message: "Selected service is not available.",
      });
    }

    const platformFee = round2(await loadTier());
    const haircutPrice = round2(Number(serviceRow.price));
    const serviceTitle = String(serviceRow.name || "Service").trim();
    const depositAmount = round2(Math.max(0, Number(body.depositAmount) || 0));
    const paymentTypeLabel = depositAmount > 0 ? "deposit" : "full";
    const serviceCharge = paymentTypeLabel === "deposit" ? depositAmount : haircutPrice;
    const total = round2(serviceCharge + platformFee);
    const remainingBalance = round2(Math.max(0, haircutPrice - depositAmount));
    const barberPayout = round2(Math.max(0, haircutPrice - platformFee));
    const tenantBiz = resolved.businessId;

    let ins;
    try {
      logDbInsertDebug({
        route: req.path,
        table: "bookings",
        barberId: barberIdRaw,
        barber_id: body.barber_id,
        resolvedBarberDbId,
        insertBarberId,
        bookingsColType,
        payload: body,
      });
      if (bookingsColType !== "uuid") {
        assertNotUuidForBigintBarberId(insertBarberId, "bookings", req.path);
      }
      const paymentTypeLabel = depositAmount > 0 ? "deposit" : "full";
      ins = await dbQuery(
        `INSERT INTO bookings (
         user_id, customer_name, customer_email, barber_name, barber_id, service, service_duration_minutes, date, time, amount,
         total_price, deposit_amount, amount_paid, remaining_balance, payment_type, payment_status, payment_provider,
         paypal_order_id, platform_fee, total_amount, booking_status, is_paid_booking,
         platform_fee_status, barber_payout_amount, barber_fee_billed, tip_amount, total_paid, business_id
       ) VALUES (
         NULL, $1, $2, $3, $4, $5, $6, $7::date, $8::time, $9,
         $10, $11, 0, $12, $13, 'unpaid', 'paypal',
         NULL, $14, $15, 'pending_payment', false,
         'pending', $16, false, 0, 0, $17
       )
       RETURNING id`,
        [
          customerName,
          customerEmail,
          confirmedBarberName,
          insertBarberId,
          serviceTitle,
          Number(serviceRow.duration_minutes) || 30,
          dateStr,
          timeSql,
          haircutPrice,
          haircutPrice,
          depositAmount,
          remainingBalance,
          paymentTypeLabel,
          platformFee,
          total,
          barberPayout,
          Number.isFinite(tenantBiz) ? tenantBiz : null,
        ],
      );
      await dbQuery(
        `UPDATE bookings SET
           service_price = COALESCE(service_price, $2),
           balance_due = COALESCE(balance_due, remaining_balance),
           amount_charged = COALESCE(amount_charged, 0)
         WHERE id = $1::uuid`,
        [ins.rows[0].id, haircutPrice],
      ).catch((colErr) => {
        if (colErr?.code !== "42703") {
          console.warn("[app-bookings] optional payment columns update skipped:", colErr?.message);
        }
      });
    } catch (insertErr) {
      console.error("[app-bookings] booking INSERT failed:", insertErr?.code, insertErr?.message);
      if (insertErr?.code === "23505") {
        return res.status(409).json({
          success: false,
          error: "slot_taken",
          message: "That time was just booked — pick another slot.",
        });
      }
      const barberErr = bookingStartErrorResponse(res, insertErr);
      if (barberErr) return barberErr;
      return res.status(500).json({
        success: false,
        error: "booking_insert_failed",
        message: insertErr?.message || "Could not create pending booking.",
      });
    }
    const bookingId = ins.rows?.[0]?.id;
    if (!bookingId) {
      return res.status(500).json({ success: false, error: "insert_failed", message: "Could not create booking row" });
    }
    logBookingInsertSuccess(bookingId);

    const paypalAmount = assertValidPayPalAmount("total", total);
    const amountString = paypalAmount.toFixed(2);
    assertValidPayPalAmount("haircutPrice", haircutPrice);
    assertValidPayPalAmount("platformFee", platformFee);

  console.log("[paypal] checkout context", {
      route: req.path,
      payload: body,
      resolvedBarber: {
        name: confirmedBarberName,
        dbId: resolvedBarberDbId,
        uuid: resolved.barberUuid,
        insertBarberId,
      },
      resolvedService: {
        id: serviceRow.id,
        name: serviceTitle,
        price: haircutPrice,
        duration: serviceRow.duration_minutes,
      },
      amounts: {
        haircutPrice,
        platformFee,
        depositAmount,
        total: paypalAmount,
        amountString,
      },
      redirectUri,
      cancelUri: cancelUri || redirectUri,
      bookingId,
      environment: getPayPalEnvironmentMeta(),
    });

    console.log("[paypal] creating order", {
      amount: paypalAmount,
      amountString,
      barberId: insertBarberId,
      serviceId: serviceRow.id,
      environment: getPayPalEnvironmentMeta().environment,
      apiBase: getPayPalEnvironmentMeta().apiBase,
    });

    if (isPayPalLive() && redirectUri && !String(redirectUri).startsWith("https://")) {
      console.warn(
        "[paypal] LIVE mode: return_url is not https — PayPal may reject order creation:",
        redirectUri,
      );
    }

    const paypalHealth = await getPayPalHealthDiagnostics();
    if (!paypalHealth.alignment?.ok) {
      console.error("[paypal] checkout blocked — env mismatch:", paypalHealth.alignment?.message);
      return res.status(503).json({
        success: false,
        error: "paypal_env_mismatch",
        message: paypalHealth.alignment?.message || "PayPal is misconfigured (sandbox vs live).",
        paypal: {
          environment: paypalHealth.environment,
          credentialMode: paypalHealth.credentialMode,
          oauth: paypalHealth.oauth,
        },
      });
    }

    const client = getPayPalHttpClient();
    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: "IFCDC Barbers — app booking",
          custom_id: String(bookingId),
          amount: {
            currency_code: "USD",
            value: amountString,
          },
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        brand_name: "IFCDC Barbers",
        return_url: redirectUri,
        cancel_url: cancelUri || redirectUri,
      },
    });

    let orderId;
    let approveUrl;
    try {
      const response = await client.execute(request);
      const result = response.result;
      orderId = result?.id;
      console.log("[paypal] create-order response", {
        orderId,
        status: result?.status,
        linkRels: (result?.links || []).map((l) => l.rel),
        environment: getPayPalEnvironmentMeta().environment,
      });
      if (!orderId) {
        await dbQuery(`DELETE FROM bookings WHERE id = $1::uuid`, [bookingId]);
        return res.status(502).json({ success: false, error: "paypal_no_order_id", message: "PayPal did not return an order id" });
      }

      const approve = (result.links || []).find(
        (l) => (l.rel || "").toLowerCase() === "approve" || (l.href || "").includes("/checkoutnow"),
      );
      approveUrl = approve?.href || "";
      if (!approveUrl) {
        console.error("[paypal] create-order missing approve link", { orderId, links: result?.links });
        await dbQuery(`DELETE FROM bookings WHERE id = $1::uuid`, [bookingId]);
        return res.status(502).json({ success: false, error: "paypal_no_approve_link", message: "PayPal did not return an approve URL" });
      }

      await dbQuery(`UPDATE bookings SET paypal_order_id = $1 WHERE id = $2::uuid`, [orderId, bookingId]);
      console.log("[app-bookings] PAYPAL RESPONSE:", {
        orderId,
        status: result?.status,
        amountString,
        approveUrl: approveUrl ? approveUrl.slice(0, 120) : null,
        bookingId,
      });
      console.log("[paypal] create-order success", { orderId, approveUrl: approveUrl.slice(0, 120) });
    } catch (pe) {
      const paypalErr = extractPayPalErrorFull(pe);
      console.error("[paypal] create-order FAILED", {
        environment: getPayPalEnvironmentMeta(),
        bookingId,
        paypalError: paypalErr,
      });
      await dbQuery(`DELETE FROM bookings WHERE id = $1::uuid`, [bookingId]).catch(() => {});
      pe.paypalDetail = paypalErr;
      throw pe;
    }

    const startPayload = {
      success: true,
      orderId,
      id: orderId,
      approveUrl,
      total,
      platformFee,
      haircutPrice,
      depositAmount,
      bookingId,
      serviceId: serviceRow.id,
      serviceName: serviceTitle,
    };
    console.log("[app-bookings] CHECKOUT START OK:", {
      orderId,
      total,
      platformFee,
      haircutPrice,
      hasApproveUrl: Boolean(approveUrl),
    });
    return res.json(startPayload);
  } catch (e) {
    console.error("[app-bookings] CHECKOUT START ERROR:", e?.message || e, e?.paypalDetail || "");
    console.error("[app-bookings] start:", e?.stack || e);
    if (e?.code === "barber_uuid_bigint_blocked") {
      return res.status(400).json({
        success: false,
        error: "barber_unresolved",
        message: BARBER_RESOLVE_MSG,
      });
    }
    const barberErr = bookingStartErrorResponse(res, e);
    if (barberErr) return barberErr;
    if (e?.code === "paypal_config") {
      return res.status(503).json({
        success: false,
        error: "paypal_config",
        message: "PayPal is not configured on the server.",
        paypal: getPayPalEnvironmentMeta(),
      });
    }
    if (e?.code === "invalid_amount") {
      return res.status(400).json({
        success: false,
        error: "invalid_amount",
        message: "Invalid checkout amount. Please reselect your service.",
      });
    }
    const isPayPalErr =
      e?.paypalDetail ||
      String(e?.message || "").includes("PayPal") ||
      String(e?.statusCode || e?.status || "").match(/^[45]/);
    if (isPayPalErr) {
      const f = formatPayPalFailure(e);
      console.error("[paypal] start checkout error", {
        error: f.code,
        message: f.message,
        httpStatus: f.httpStatus,
        body: f.body,
        environment: getPayPalEnvironmentMeta(),
      });
      const status = Number(f.httpStatus) >= 400 && Number(f.httpStatus) < 600 ? f.httpStatus : 502;
      return res.status(status).json({
        success: false,
        error: f.code || "start_failed",
        message: f.message || `PayPal checkout failed (${f.code || "paypal_error"}).`,
        paypalDetail: f.body || e?.paypalDetail || null,
        paypal: getPayPalEnvironmentMeta(),
      });
    }
    const detail = e?.message ? String(e.message).slice(0, 240) : "server_error";
    return res.status(500).json({
      success: false,
      error: "server_error",
      message: detail || "Checkout failed on the server.",
    });
  }
});

router.post("/finalize", async (req, res) => {
  try {
    const orderID = stripQuotes(req.body?.orderID ?? req.body?.orderId ?? "");
    if (!orderID) {
      return res.status(400).json({ verified: false, error: "order_id_required", message: "orderID is required" });
    }

    const client = getPayPalHttpClient();
    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const response = await client.execute(capReq);
    const capture = response.result;

    const { dbQuery } = await loadDb();

    const markPaymentFailed = async (bookingId, status = PAYMENT_STATUS.PAYMENT_FAILED) => {
      if (!bookingId) return;
      await dbQuery(
        `UPDATE bookings SET payment_status = $2, booking_status = 'pending_payment', is_paid_booking = false WHERE id = $1::uuid`,
        [bookingId, status],
      ).catch(() => {});
    };

    if (capture?.status !== "COMPLETED") {
      const pending = await dbQuery(
        `SELECT id FROM bookings WHERE paypal_order_id = $1 LIMIT 1`,
        [orderID],
      );
      await markPaymentFailed(pending.rows?.[0]?.id);
      return res.status(400).json({
        verified: false,
        error: "capture_not_completed",
        message: "Payment failed — booking not confirmed.",
      });
    }

    const captureId = extractCaptureIdFromOrder(capture);
    if (!captureId) {
      const pending = await dbQuery(
        `SELECT id FROM bookings WHERE paypal_order_id = $1 LIMIT 1`,
        [orderID],
      );
      await markPaymentFailed(pending.rows?.[0]?.id);
      return res.status(400).json({
        verified: false,
        error: "no_capture_id",
        message: "Payment failed — booking not confirmed.",
      });
    }

    const found = await dbQuery(
      `SELECT id, user_id, business_id, customer_name, customer_email, service, service_duration_minutes,
              barber_id, barber_name, date, time, total_price, deposit_amount, tip_amount,
              remaining_balance, platform_fee, amount_paid, amount_charged, balance_due,
              service_price, payment_status, paypal_capture_id
       FROM bookings WHERE paypal_order_id = $1 LIMIT 1`,
      [orderID],
    );
    const row = found.rows?.[0];
    if (!row) {
      return res.status(404).json({
        verified: false,
        error: "booking_not_found",
        message: "No pending booking for this PayPal order",
      });
    }

    const haircutPrice = round2(Number(row.service_price ?? row.total_price ?? row.amount ?? 0));
    const depositAmount = round2(Number(row.deposit_amount ?? 0));
    const platformFee = round2(resolvePlatformFeeUsd(row.platform_fee));
    const tipAmount = round2(Number(row.tip_amount ?? 0));

    if (
      row.paypal_capture_id &&
      String(row.paypal_capture_id) === captureId &&
      isBookingPaymentSettled(row)
    ) {
      const view = bookingPaymentViewFromRow(row);
      return res.json({
        verified: true,
        booking: {
          id: row.id,
          barberName: row.barber_name,
          date: row.date,
          time: row.time,
          service: row.service,
          ...view,
          haircutPrice: view.servicePrice,
          total: view.totalDue,
        },
      });
    }

    const capturedUsd = extractPayPalCapturedUsd(capture);
    if (capturedUsd == null) {
      await markPaymentFailed(row.id, PAYMENT_STATUS.PAYMENT_FAILED);
      return res.status(400).json({
        verified: false,
        error: "no_capture_amount",
        message: "Payment failed — booking not confirmed.",
      });
    }

    const settlement = computeSettlementFromCapture({
      servicePrice: haircutPrice,
      depositAmount,
      platformFee,
      tipAmount,
      capturedUsd,
      captureId,
      paymentProvider: "paypal",
    });

    if (!settlement.ok) {
      const failStatus =
        settlement.paymentStatus === PAYMENT_STATUS.PAYMENT_MISMATCH
          ? PAYMENT_STATUS.PAYMENT_MISMATCH
          : PAYMENT_STATUS.PAYMENT_FAILED;
      await markPaymentFailed(row.id, failStatus);
      return res.status(400).json({
        verified: false,
        error: settlement.error,
        message: settlement.message || "Payment failed — booking not confirmed.",
      });
    }

    const { sql, values } = settlementUpdateParams(row.id, settlement, captureId);
    await dbQuery(sql, values);

    const updated = await dbQuery(
      `SELECT id, barber_name, date, time, service, service_price, total_price, amount, deposit_amount,
              balance_due, remaining_balance, platform_fee, tip_amount, amount_charged, amount_paid,
              total_paid, payment_status, payment_method, payment_provider, paypal_capture_id,
              stripe_payment_intent_id, payment_id, total_amount, customer_name, customer_email,
              service_duration_minutes, barber_name
       FROM bookings WHERE id = $1::uuid LIMIT 1`,
      [row.id],
    );
    const fresh = updated.rows?.[0] || row;
    if (!isBookingPaymentSettled(fresh)) {
      await markPaymentFailed(row.id, PAYMENT_STATUS.PAYMENT_FAILED);
      return res.status(400).json({
        verified: false,
        error: "payment_not_settled",
        message: "Payment failed — booking not confirmed.",
      });
    }

    if (shouldSendPaidConfirmationEmail(settlement.paymentStatus)) {
      try {
        const { sendBookingEmail } = require("./bookingEmail.cjs");
        const view = bookingPaymentViewFromRow(fresh);
        await sendBookingEmail({
          name: row.customer_name || "Guest",
          email: row.customer_email,
          service: row.service || "Haircut",
          servicePrice: view.servicePrice,
          serviceDuration: row.service_duration_minutes,
          date: String(row.date ?? ""),
          time: String(row.time ?? ""),
          paymentStatus: paymentStatusForEmailFromRow(fresh),
          paymentId: captureId,
          captureId,
          barberName: row.barber_name,
          platformFee: view.platformFee,
          tipAmount: view.tipAmount,
          amountCharged: view.amountCharged,
          amountPaid: view.amountPaid,
          balanceDue: view.balanceDue,
          bookingRow: fresh,
        });
        console.log("[app-bookings] payment confirmation email sent:", row.customer_email, view.paymentStatus);
      } catch (mailErr) {
        console.warn("[app-bookings] confirmation email failed:", mailErr?.message || mailErr);
      }
    } else {
      console.warn("[app-bookings] skipped paid confirmation email — status not settled", settlement.paymentStatus);
    }

    // Best-effort push fanout — only after verified payment.
    try {
      const pushNotifier = require("./pushNotifier.cjs");
      const bookingPayload = {
        id: row.id,
        user_id: row.user_id || null,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        barber_name: row.barber_name,
        barber_id: row.barber_id,
        business_id: row.business_id || null,
        service: row.service,
        date: row.date,
        time: row.time,
      };
      // Customer gets confirmation; barber + shop owners get the new-booking alert.
      void pushNotifier
        .sendBookingPush({
          dbQuery,
          booking: bookingPayload,
          kind: "booking_confirmation",
          audience: ["customer"],
          data: { bookingId: row.id },
        })
        .catch((e) => console.warn("[app-bookings] push (customer) failed:", e?.message || e));
      void pushNotifier
        .sendBookingPush({
          dbQuery,
          booking: bookingPayload,
          kind: "new_booking_for_barber",
          audience: ["barber", "shop_owners"],
          data: { bookingId: row.id },
        })
        .catch((e) => console.warn("[app-bookings] push (barber) failed:", e?.message || e));
    } catch (pushErr) {
      console.warn("[app-bookings] push dispatcher unavailable:", pushErr?.message || pushErr);
    }

    const view = bookingPaymentViewFromRow(fresh);

    return res.json({
      verified: true,
      booking: {
        id: fresh.id,
        barberName: fresh.barber_name,
        date: fresh.date,
        time: fresh.time,
        service: fresh.service,
        ...view,
        haircutPrice: view.servicePrice,
        total: view.totalDue,
      },
    });
  } catch (e) {
    if (e?.code === "paypal_config") {
      return res.status(503).json({ verified: false, error: "paypal_config", message: e.message });
    }
    const f = formatPayPalFailure(e);
    console.error("[app-bookings] finalize:", f.message);
    const status = Number(f.httpStatus) >= 400 && Number(f.httpStatus) < 600 ? f.httpStatus : 502;
    return res.status(status).json({ verified: false, error: f.code || "finalize_failed", message: f.message });
  }
});

module.exports = router;
