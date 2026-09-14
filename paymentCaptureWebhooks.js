import { dbQuery } from "./db.js";
import { getPayPalHttpClient, ordersGetRequest } from "./paypalClient.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * PayPal Dashboard can POST the same webhook to /api/payments/deposit-webhook (or the generic webhook).
 * Updates bookings (deposit) or barber_settings (Pro) when custom_id matches.
 *
 * @param {object} body
 * @returns {Promise<{ handled: boolean, kind?: string }>}
 */
export async function handlePaymentsDepositProWebhook(body) {
  const type = String(body?.event_type || "");
  if (type !== "PAYMENT.CAPTURE.COMPLETED") {
    return { handled: false };
  }

  const resource = body.resource || {};
  const captureId = String(resource.id || "").trim();
  const amountObj = resource.amount || {};
  const capturedUsd = round2(Number(amountObj.value));
  const currency = String(amountObj.currency_code || "USD").toUpperCase();

  const orderId = String(
    resource.supplementary_data?.related_ids?.order_id || resource.order_id || "",
  ).trim();
  if (!orderId || !captureId || currency !== "USD" || !Number.isFinite(capturedUsd)) {
    console.warn("[payments-webhook] missing order/capture/amount", { orderId, captureId, capturedUsd, currency });
    return { handled: false };
  }

  let customId = "";
  try {
    const client = getPayPalHttpClient();
    const resp = await client.execute(ordersGetRequest(orderId));
    const order = resp.result;
    customId = String(order?.purchase_units?.[0]?.custom_id || "").trim();
  } catch (e) {
    console.error("[payments-webhook] orders get failed:", e?.message || e);
    return { handled: false };
  }

  if (customId.toLowerCase().startsWith("deposit:")) {
    const bookingId = customId.slice("deposit:".length).trim();
    if (!bookingId) return { handled: false };

    const r = await dbQuery(
      `SELECT id, deposit_amount::float8 AS deposit_amount, deposit_status, deposit_transaction_id
       FROM bookings WHERE id = $1::uuid LIMIT 1`,
      [bookingId],
    );
    const row = r.rows?.[0];
    if (!row) {
      console.warn("[payments-webhook] booking not found for deposit", bookingId);
      return { handled: false };
    }
    if (String(row.deposit_status || "").toLowerCase() === "paid") {
      return { handled: true, kind: "deposit_duplicate" };
    }
    if (String(row.deposit_transaction_id || "").trim() === captureId) {
      return { handled: true, kind: "deposit_duplicate" };
    }
    const expected = round2(Number(row.deposit_amount));
    if (Math.abs(capturedUsd - expected) > 0.02) {
      console.error("[payments-webhook] deposit amount mismatch", {
        bookingId,
        capturedUsd,
        expected,
      });
      await dbQuery(`UPDATE bookings SET deposit_status = $2 WHERE id = $1::uuid`, [bookingId, "failed"]);
      return { handled: true, kind: "deposit_amount_mismatch" };
    }

    await dbQuery(
      `UPDATE bookings SET
         deposit_status = 'paid',
         deposit_transaction_id = $2,
         deposit_paypal_order_id = COALESCE(deposit_paypal_order_id, $3),
         payment_status = 'deposit_paid',
         is_paid_booking = true,
         booking_status = 'confirmed',
         amount_paid = $4::numeric,
         remaining_balance = GREATEST(
           0::numeric,
           COALESCE(total_price, amount, 0)::numeric - $4::numeric
         )
       WHERE id = $1::uuid AND deposit_status IS DISTINCT FROM 'paid'`,
      [bookingId, captureId, orderId, capturedUsd],
    );
    console.log("[payments-webhook] deposit marked paid", { bookingId, captureId });
    return { handled: true, kind: "deposit_paid" };
  }

  if (customId.toLowerCase().startsWith("pro:")) {
    /* Frozen as SaaS: still mirrors barber_settings.is_pro for historical reads. Does not write account_subscriptions. */
    const barberId = Number(customId.slice("pro:".length));
    if (!Number.isFinite(barberId)) return { handled: false };
    if (Math.abs(capturedUsd - 9.99) > 0.02) {
      console.error("[payments-webhook] pro amount mismatch", { barberId, capturedUsd });
      return { handled: true, kind: "pro_amount_mismatch" };
    }

    const prev = await dbQuery(
      `SELECT pro_transaction_id FROM barber_settings WHERE barber_id = $1 LIMIT 1`,
      [barberId],
    );
    const existingCap = String(prev.rows?.[0]?.pro_transaction_id || "").trim();
    if (existingCap && existingCap === captureId) {
      return { handled: true, kind: "pro_duplicate" };
    }

    await dbQuery(
      `UPDATE barber_settings SET
         is_pro = true,
         pro_purchase_status = 'paid',
         pro_transaction_id = $2,
         pro_purchased_at = COALESCE(pro_purchased_at, NOW())
       WHERE barber_id = $1`,
      [barberId, captureId],
    );
    console.log("[payments-webhook] pro marked paid", { barberId, captureId });
    return { handled: true, kind: "pro_paid" };
  }

  return { handled: false };
}
