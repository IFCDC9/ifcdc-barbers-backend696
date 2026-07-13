/**
 * PayPal Orders v2 capture with idempotent GET fallback when the order was already captured
 * (common when the customer completes payment in the mobile browser before /finalize runs).
 */
const paypalSdk = require("@paypal/checkout-server-sdk");

function isPayPalOrderAlreadyCapturedError(err) {
  if (!err) return false;
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("order_already_captured") || lower.includes("already been captured")) {
    return true;
  }
  try {
    const j = JSON.parse(raw);
    const details = Array.isArray(j.details) ? j.details : [];
    if (details.some((d) => String(d?.issue || "").toUpperCase() === "ORDER_ALREADY_CAPTURED")) {
      return true;
    }
    const name = String(j.name || j.error || "").toUpperCase();
    if (name.includes("UNPROCESSABLE") && lower.includes("captured")) return true;
  } catch {
    /* not JSON */
  }
  return false;
}

function extractCaptureIdFromOrder(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const pu of units) {
    const caps = pu?.payments?.captures;
    if (!Array.isArray(caps)) continue;
    for (const c of caps) {
      if (c?.id != null && String(c.id).trim() !== "") return String(c.id).trim();
    }
  }
  return null;
}

/** Read-only order GET — does not capture. */
async function getPayPalOrder(client, orderID) {
  const getReq = new paypalSdk.orders.OrdersGetRequest(orderID);
  const getRes = await client.execute(getReq);
  return getRes.result;
}

/**
 * @param {import('@paypal/checkout-server-sdk').core.PayPalHttpClient} client
 * @param {string} orderID
 * @returns {Promise<{ order: object, captureId: string|null, alreadyCaptured: boolean }>}
 */
async function captureOrGetCompletedPayPalOrder(client, orderID) {
  try {
    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const response = await client.execute(capReq);
    const order = response.result;
    const captureId = extractCaptureIdFromOrder(order);
    return { order, captureId, alreadyCaptured: false };
  } catch (err) {
    if (!isPayPalOrderAlreadyCapturedError(err)) {
      throw err;
    }
    console.warn("[paypal] capture returned ORDER_ALREADY_CAPTURED — fetching order", { orderID });
    const order = await getPayPalOrder(client, orderID);
    if (String(order?.status || "").toUpperCase() !== "COMPLETED") {
      throw err;
    }
    const captureId = extractCaptureIdFromOrder(order);
    return { order, captureId, alreadyCaptured: true };
  }
}

module.exports = {
  isPayPalOrderAlreadyCapturedError,
  extractCaptureIdFromOrder,
  getPayPalOrder,
  captureOrGetCompletedPayPalOrder,
};
