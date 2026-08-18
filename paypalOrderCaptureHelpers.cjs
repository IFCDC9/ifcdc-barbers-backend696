/**
 * PayPal Orders v2 capture helpers — GET-before-capture, never double-charge,
 * full UNPROCESSABLE_ENTITY detail logging (details[] + debug_id).
 */
const paypalSdk = require("@paypal/checkout-server-sdk");

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

/** Normalize PayPal SDK / HTTP errors into a structured object. */
function parsePayPalSdkError(err) {
  if (!err) {
    return {
      name: "paypal_error",
      message: "Unknown PayPal error",
      httpStatus: 502,
      details: [],
      debugId: null,
      body: null,
    };
  }
  const httpStatus = Number(err.statusCode ?? err.status ?? 0) || 502;
  const raw = err instanceof Error ? err.message : String(err);
  const body = safeJsonParse(raw) || (typeof err._originalError?.text === "string"
    ? safeJsonParse(err._originalError.text)
    : null);

  const details = Array.isArray(body?.details) ? body.details : [];
  const debugId =
    body?.debug_id ||
    body?.debugId ||
    err.headers?.["paypal-debug-id"] ||
    err.headers?.["PayPal-Debug-Id"] ||
    null;
  const issue = details.map((d) => String(d?.issue || "").toUpperCase()).filter(Boolean);
  const name = String(body?.name || body?.error || err.code || "paypal_error");
  const description =
    details[0]?.description ||
    body?.message ||
    body?.error_description ||
    raw;

  return {
    name,
    message: String(description || name),
    httpStatus,
    details,
    issues: issue,
    debugId: debugId ? String(debugId) : null,
    body: body || { raw: String(raw).slice(0, 4000) },
  };
}

function isPayPalOrderAlreadyCapturedError(err) {
  const parsed = parsePayPalSdkError(err);
  if (parsed.issues.includes("ORDER_ALREADY_CAPTURED")) return true;
  const blob = `${parsed.name} ${parsed.message} ${JSON.stringify(parsed.body || {})}`.toLowerCase();
  return (
    blob.includes("order_already_captured") ||
    blob.includes("already been captured") ||
    (parsed.name.toUpperCase().includes("UNPROCESSABLE") && blob.includes("captured"))
  );
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

function extractOrderAmountUsd(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const pu of units) {
    const v = pu?.amount?.value ?? pu?.payments?.captures?.[0]?.amount?.value;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

function extractOrderCurrency(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const pu of units) {
    const c = pu?.amount?.currency_code ?? pu?.payments?.captures?.[0]?.amount?.currency_code;
    if (c) return String(c).toUpperCase();
  }
  return "USD";
}

function extractPayerPhoneFromPayPalOrder(order) {
  const payer = order?.payer || {};
  const phoneObj = payer.phone?.phone_number || payer.phone_number || {};
  const country = String(phoneObj.country_code || payer.phone?.country_code || "").replace(/\D/g, "");
  const national = String(phoneObj.national_number || phoneObj.number || "").replace(/\D/g, "");
  if (country && national) return `+${country}${national}`;
  if (national) return national;
  const shippingPhone =
    order?.purchase_units?.[0]?.shipping?.phone_number ||
    order?.purchase_units?.[0]?.shipping?.address?.phone ||
    "";
  const raw = String(
    shippingPhone ||
      payer.phone_number ||
      (typeof payer.phone === "string" ? payer.phone : "") ||
      "",
  ).trim();
  return raw || null;
}

/** Read-only order GET — does not capture. */
async function getPayPalOrder(client, orderID) {
  const getReq = new paypalSdk.orders.OrdersGetRequest(orderID);
  const getRes = await client.execute(getReq);
  return getRes.result;
}

function makeOrderNotApprovedError(orderID, status) {
  const body = {
    name: "UNPROCESSABLE_ENTITY",
    details: [
      {
        issue: "ORDER_NOT_APPROVED",
        description: `PayPal order ${orderID} is ${status || "unknown"} — complete payment in PayPal before finalize.`,
      },
    ],
    message: `PayPal order is not approved (status=${status || "unknown"}).`,
  };
  const err = new Error(JSON.stringify(body));
  err.statusCode = 422;
  err.code = "ORDER_NOT_APPROVED";
  err.paypalParsed = parsePayPalSdkError(err);
  return err;
}

/**
 * Capture once. If already captured, return the completed order (never double-charge).
 * Always GET first so we never capture CREATED / VOIDED / EXPIRED orders.
 *
 * @param {import('@paypal/checkout-server-sdk').core.PayPalHttpClient} client
 * @param {string} orderID
 * @returns {Promise<{ order: object, captureId: string|null, alreadyCaptured: boolean, orderAmount: number|null, currency: string }>}
 */
async function captureOrGetCompletedPayPalOrder(client, orderID) {
  const id = String(orderID || "").trim();
  if (!id) {
    const err = new Error("orderID is required");
    err.statusCode = 400;
    err.code = "order_id_required";
    throw err;
  }

  let existing = null;
  try {
    existing = await getPayPalOrder(client, id);
  } catch (peekErr) {
    const parsed = parsePayPalSdkError(peekErr);
    console.error("[paypal] OrdersGet before capture FAILED", {
      orderID: id,
      httpStatus: parsed.httpStatus,
      name: parsed.name,
      debugId: parsed.debugId,
      details: parsed.details,
      body: parsed.body,
    });
    peekErr.paypalParsed = parsed;
    throw peekErr;
  }

  const status = String(existing?.status || "").toUpperCase();
  console.log("[paypal] pre-capture order status", {
    orderID: id,
    status,
    amount: extractOrderAmountUsd(existing),
    currency: extractOrderCurrency(existing),
  });

  if (status === "COMPLETED") {
    return {
      order: existing,
      captureId: extractCaptureIdFromOrder(existing),
      alreadyCaptured: true,
      orderAmount: extractOrderAmountUsd(existing),
      currency: extractOrderCurrency(existing),
    };
  }

  if (status === "VOIDED" || status === "EXPIRED") {
    const err = makeOrderNotApprovedError(id, status);
    throw err;
  }

  if (status !== "APPROVED") {
    // CREATED / PAYER_ACTION_REQUIRED / SAVED — payer never finished approval.
    throw makeOrderNotApprovedError(id, status);
  }

  try {
    const capReq = new paypalSdk.orders.OrdersCaptureRequest(id);
    capReq.headers = {
      ...(capReq.headers || {}),
      // Idempotent capture — same order never charged twice by PayPal.
      "PayPal-Request-Id": `ifcdc-capture-${id}`,
      Prefer: "return=representation",
    };
    capReq.requestBody({});
    const response = await client.execute(capReq);
    const order = response.result;
    const captureId = extractCaptureIdFromOrder(order);
    console.log("[paypal] capture OK", {
      orderID: id,
      status: order?.status,
      captureId,
      amount: extractOrderAmountUsd(order),
      currency: extractOrderCurrency(order),
    });
    return {
      order,
      captureId,
      alreadyCaptured: false,
      orderAmount: extractOrderAmountUsd(order),
      currency: extractOrderCurrency(order),
    };
  } catch (err) {
    const parsed = parsePayPalSdkError(err);
    console.error("[paypal] capture FAILED", {
      orderID: id,
      httpStatus: parsed.httpStatus,
      name: parsed.name,
      debugId: parsed.debugId,
      details: parsed.details,
      issues: parsed.issues,
      body: parsed.body,
    });
    err.paypalParsed = parsed;

    if (!isPayPalOrderAlreadyCapturedError(err)) {
      throw err;
    }

    console.warn("[paypal] capture returned ORDER_ALREADY_CAPTURED — fetching order", { orderID: id });
    const order = await getPayPalOrder(client, id);
    if (String(order?.status || "").toUpperCase() !== "COMPLETED") {
      throw err;
    }
    const captureId = extractCaptureIdFromOrder(order);
    return {
      order,
      captureId,
      alreadyCaptured: true,
      orderAmount: extractOrderAmountUsd(order),
      currency: extractOrderCurrency(order),
    };
  }
}

module.exports = {
  parsePayPalSdkError,
  isPayPalOrderAlreadyCapturedError,
  extractCaptureIdFromOrder,
  extractOrderAmountUsd,
  extractOrderCurrency,
  extractPayerPhoneFromPayPalOrder,
  getPayPalOrder,
  captureOrGetCompletedPayPalOrder,
};
