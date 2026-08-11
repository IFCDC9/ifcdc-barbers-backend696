/**
 * Super Admin–only Manual Booking (Bypass Mode) routes.
 */
import express from "express";
import { extractBearerToken, resolveAuthPayload } from "./authRoutes.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import {
  BYPASS_PAYMENT_TYPES,
  cancelManualBypassBooking,
  convertBypassBookingToPaid,
  createManualBypassBooking,
  requireSuperAdminActor,
} from "./manualBypassBookingService.js";
import { ensureManualBypassBookingColumns } from "./manualBypassBookingMigrations.js";
import { dbQuery } from "./db.js";

function requireSuperAdminJwt(req, res, next) {
  const token = extractBearerToken(req.headers?.authorization || req.get?.("authorization"));
  if (!token) {
    return res.status(401).json({ ok: false, message: "Missing Bearer token" });
  }
  const payload = resolveAuthPayload(token);
  if (!payload) {
    return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  }
  req.user = payload;
  if (!isJwtGlobalSuperScope(payload) && payload.isOwner !== true) {
    return res.status(403).json({
      ok: false,
      message: "Manual Booking (Bypass Mode) is restricted to Super Admin only.",
    });
  }
  return next();
}

/**
 * Start PayPal for an existing pending bypass paid_online booking.
 * Reuses app-bookings PayPal client when available.
 */
async function startPayPalForBooking(booking) {
  const { getPayPalHttpClient, isPayPalLive } = await import("./paypalClient.js");
  const paypalSdkMod = await import("@paypal/checkout-server-sdk");
  const paypalSdk = paypalSdkMod.default || paypalSdkMod;
  const amount = Math.max(
    0.01,
    Number(booking.total_amount || booking.total_price || booking.amount || 0),
  );
  const amountString = amount.toFixed(2);
  const client = getPayPalHttpClient();
  const request = new paypalSdk.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  const base =
    String(process.env.PUBLIC_WEB_URL || process.env.FRONTEND_URL || "https://ifcdcbarbersapp.com").replace(
      /\/$/,
      "",
    );
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: { currency_code: "USD", value: amountString },
        description: `IFCDC booking ${String(booking.id).slice(0, 8)}`,
        custom_id: String(booking.id),
      },
    ],
    application_context: {
      brand_name: "IFCDC Barbers",
      user_action: "PAY_NOW",
      return_url: `${base}/booking?paypal=return&bookingId=${encodeURIComponent(booking.id)}`,
      cancel_url: `${base}/booking?paypal=cancel&bookingId=${encodeURIComponent(booking.id)}`,
    },
  });
  const response = await client.execute(request);
  const orderId = response?.result?.id;
  if (!orderId) throw new Error("paypal_order_missing");
  await dbQuery(`UPDATE bookings SET paypal_order_id = $1 WHERE id = $2::uuid`, [
    orderId,
    booking.id,
  ]);
  const approve = (response?.result?.links || []).find((l) => l.rel === "approve")?.href || null;
  return {
    ok: true,
    orderID: orderId,
    approveUrl: approve,
    environment: isPayPalLive() ? "live" : "sandbox",
    amount: amountString,
  };
}

export function createManualBypassBookingRouter({ sendBookingEmail } = {}) {
  const router = express.Router();

  router.use(requireSuperAdminJwt);

  router.get("/payment-types", (_req, res) => {
    res.json({
      ok: true,
      paymentTypes: [
        {
          id: BYPASS_PAYMENT_TYPES.PAID_ONLINE,
          label: "Paid Online",
          description: "Existing PayPal checkout. Platform fee applies.",
        },
        {
          id: BYPASS_PAYMENT_TYPES.COMPLIMENTARY,
          label: "Complimentary (No Charge)",
          description: "Total $0. Skips payment. SMS confirmation sent.",
        },
        {
          id: BYPASS_PAYMENT_TYPES.PAY_AT_SHOP,
          label: "Pay at Shop",
          description: "Confirmed without online payment. No platform fee.",
        },
        {
          id: BYPASS_PAYMENT_TYPES.STAFF_TRAINING,
          label: "Staff / Training",
          description: "Internal block for training, meetings, or personal time.",
        },
      ],
    });
  });

  /** Search existing clients for picker */
  router.get("/clients", async (req, res) => {
    try {
      const q = String(req.query.q || req.query.query || "").trim();
      if (q.length < 2) {
        return res.json({ ok: true, clients: [] });
      }
      const r = await dbQuery(
        `SELECT id, name, email, phone, phone_e164, role
         FROM app_users
         WHERE lower(role) IN ('user', 'customer')
           AND (
             lower(coalesce(email,'')) LIKE lower($1)
             OR lower(coalesce(name,'')) LIKE lower($1)
             OR coalesce(phone_e164,'') LIKE $2
             OR regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE $3
           )
         ORDER BY name ASC NULLS LAST
         LIMIT 25`,
        [`%${q}%`, `%${q.replace(/\D/g, "")}%`, `%${q.replace(/\D/g, "")}%`],
      );
      return res.json({
        ok: true,
        clients: (r.rows || []).map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone_e164 || row.phone || null,
        })),
      });
    } catch (e) {
      console.error("[manual-bypass] clients search:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Client search failed" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const gate = requireSuperAdminActor(req);
      if (!gate.ok) return res.status(gate.status).json({ ok: false, message: gate.message });

      await ensureManualBypassBookingColumns(dbQuery);
      const result = await createManualBypassBooking({
        actor: gate.user,
        body: req.body || {},
        sendBookingEmail,
        startPaidOnlineCheckout: startPayPalForBooking,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json(result);
      }
      return res.status(201).json(result);
    } catch (e) {
      console.error("[manual-bypass] create failed:", e?.stack || e);
      const detail = String(e?.message || e || "unknown_error").slice(0, 500);
      return res.status(500).json({
        ok: false,
        code: e?.code || "manual_bypass_create_failed",
        message: "Could not create manual booking",
        detail,
      });
    }
  });

  router.post("/:id/convert-to-paid", async (req, res) => {
    try {
      const gate = requireSuperAdminActor(req);
      if (!gate.ok) return res.status(gate.status).json({ ok: false, message: gate.message });
      const mode = String(req.body?.mode || "mark_paid").trim().toLowerCase();
      const result = await convertBypassBookingToPaid({
        bookingId: req.params.id,
        actor: gate.user,
        mode: mode === "start_online" ? "start_online" : "mark_paid",
        note: req.body?.note || null,
        startPaidOnlineCheckout: startPayPalForBooking,
      });
      if (!result.ok) return res.status(result.status || 400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[manual-bypass] convert failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not convert booking" });
    }
  });

  router.post("/:id/cancel", async (req, res) => {
    try {
      const gate = requireSuperAdminActor(req);
      if (!gate.ok) return res.status(gate.status).json({ ok: false, message: gate.message });
      const result = await cancelManualBypassBooking({
        bookingId: req.params.id,
        actor: gate.user,
        note: req.body?.note || null,
      });
      if (!result.ok) return res.status(result.status || 400).json(result);
      return res.json(result);
    } catch (e) {
      console.error("[manual-bypass] cancel failed:", e?.stack || e);
      return res.status(500).json({ ok: false, message: "Could not cancel booking" });
    }
  });

  return router;
}
