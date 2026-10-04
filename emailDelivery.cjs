/**
 * Booking transactional delivery.
 * Postmark is primary when POSTMARK_SERVER_TOKEN is set (same name HQ uses).
 * Resend is the fallback only when Postmark is unset or rejects the message
 * before acceptance. An uncertain Postmark response does not fall through.
 *
 * From address: MAIL_FROM, else the existing Barbers fallback in getMailFrom().
 * Do not invent a new From. The domain must be verified on Postmark before a live send.
 *
 * Env names only: POSTMARK_SERVER_TOKEN, MAIL_FROM, RESEND_API_KEY.
 * Idempotency lives in email_delivery_claims and survives process restart.
 */
const { getMailFrom, getResend } = require("./emailResend.cjs");
const { authorizeOutboundEmail } = require("./emailSecurityGate.cjs");

const CLAIM_TABLE = "email_delivery_claims";
const BOOKING_FROM_FALLBACK = "IFCDC Barbers <service@ifcdcbarbersapp.com>";

function resolveBookingFrom(explicit) {
  return String(explicit || getMailFrom() || BOOKING_FROM_FALLBACK).trim();
}

function postmarkToken() {
  return String(process.env.POSTMARK_SERVER_TOKEN || "").trim();
}

function postmarkConfigured() {
  return postmarkToken().length > 0;
}

async function ensureClaimTable(dbQuery) {
  await dbQuery(
    `CREATE TABLE IF NOT EXISTS ${CLAIM_TABLE} (
      idempotency_key text PRIMARY KEY,
      template_id text NOT NULL,
      status text NOT NULL,
      provider text,
      message_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
}

async function claimDelivery(dbQuery, key, templateId) {
  await ensureClaimTable(dbQuery);
  const inserted = await dbQuery(
    `INSERT INTO ${CLAIM_TABLE} (idempotency_key, template_id, status)
     VALUES ($1, $2, 'in_flight')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING status`,
    [key, templateId],
  );
  if (inserted?.rows?.length) return { claimed: true, status: "in_flight" };

  const current = await dbQuery(
    `SELECT status FROM ${CLAIM_TABLE} WHERE idempotency_key = $1`,
    [key],
  );
  const status = current?.rows?.[0]?.status || "unknown";
  if (status === "failed") {
    const reclaimed = await dbQuery(
      `UPDATE ${CLAIM_TABLE}
       SET status = 'in_flight', template_id = $2, provider = NULL, message_id = NULL, updated_at = now()
       WHERE idempotency_key = $1 AND status = 'failed'
       RETURNING status`,
      [key, templateId],
    );
    if (reclaimed?.rows?.length) return { claimed: true, status: "in_flight" };
  }
  return { claimed: false, status };
}

async function markDelivery(dbQuery, key, status, meta = {}) {
  await dbQuery(
    `UPDATE ${CLAIM_TABLE}
     SET status = $1, provider = $2, message_id = $3, updated_at = now()
     WHERE idempotency_key = $4`,
    [status, meta.provider || null, meta.messageId || null, key],
  );
}

function createSqlLedger(dbQuery) {
  return {
    claim: (key, templateId) => claimDelivery(dbQuery, key, templateId),
    mark: (key, status, meta) => markDelivery(dbQuery, key, status, meta),
  };
}

async function defaultLedger() {
  const { dbQuery } = require("./db.js");
  return createSqlLedger(dbQuery);
}

/**
 * @param {number} status
 * @returns {"accepted"|"uncertain"|"rejected"}
 */
function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 408 || status === 429 || status >= 500) return "uncertain";
  return "rejected";
}

async function sendViaPostmark({ fetchImpl, from, to, subject, html, text }) {
  if (!postmarkConfigured()) {
    return { configured: false, success: false, uncertain: false };
  }
  const token = postmarkToken();
  let res;
  try {
    res = await fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: from,
        To: Array.isArray(to) ? to.join(",") : String(to),
        Subject: subject,
        TextBody: text || "",
        HtmlBody: html || text || "",
        MessageStream: "outbound",
      }),
    });
  } catch {
    return { configured: true, success: false, uncertain: true, error: "postmark_uncertain" };
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  const kind = classifyHttpStatus(res.status);
  if (kind === "uncertain") {
    return { configured: true, success: false, uncertain: true, error: "postmark_uncertain" };
  }
  const errorCode = typeof data.ErrorCode === "number" ? data.ErrorCode : 0;
  if (kind === "rejected" || errorCode !== 0) {
    return { configured: true, success: false, uncertain: false, error: "postmark_rejected" };
  }
  return {
    configured: true,
    success: true,
    uncertain: false,
    provider: "postmark",
    messageId: data.MessageID || null,
  };
}

async function defaultSendResend({ to, subject, html, text, from }) {
  const client = getResend();
  if (!client) return { configured: false, success: false, uncertain: false, error: "resend_not_configured" };
  try {
    const response = await client.emails.send({
      from: resolveBookingFrom(from),
      to,
      subject,
      html,
      text,
    });
    if (response?.error) {
      return { configured: true, success: false, uncertain: false, error: "resend_rejected" };
    }
    return {
      configured: true,
      success: true,
      uncertain: false,
      provider: "resend",
      messageId: response?.data?.id || response?.id || null,
    };
  } catch {
    return { configured: true, success: false, uncertain: true, error: "resend_uncertain" };
  }
}

/**
 * One customer (or admin) notification. Claims the idempotency key before any provider call.
 * sent and uncertain claims block a later attempt, including after process restart.
 */
async function deliverTransactionalEmail(input = {}) {
  const templateId = String(input.templateId || "").trim();
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  const to = input.to;
  const subject = String(input.subject || "");
  const html = input.html || "";
  const text = input.text || "";
  const label = input.label || templateId;
  if (!templateId || !idempotencyKey || !to || !subject) {
    return { success: false, error: "delivery_missing_fields" };
  }

  const from = resolveBookingFrom(input.from);
  const gate = authorizeOutboundEmail({
    to,
    subject,
    html,
    text,
    from,
    templateId,
    label,
  });
  if (!gate.ok) {
    return { success: false, error: gate.error, blocked: true };
  }

  const ledger = input.ledger || (await defaultLedger());
  const claim = await ledger.claim(idempotencyKey, gate.templateId);
  if (!claim.claimed) {
    return { success: true, duplicate: true, skipped: true, status: claim.status, provider: null };
  }

  const fetchImpl = input.fetchImpl || fetch;
  const postmark = await sendViaPostmark({ fetchImpl, from, to, subject, html, text });
  if (postmark.success) {
    await ledger.mark(idempotencyKey, "sent", { provider: "postmark", messageId: postmark.messageId });
    return { success: true, duplicate: false, provider: "postmark", messageId: postmark.messageId, fallbackUsed: false };
  }
  if (postmark.uncertain) {
    await ledger.mark(idempotencyKey, "uncertain", { provider: "postmark" });
    return { success: false, uncertain: true, fallbackUsed: false, error: "postmark_uncertain", provider: "postmark" };
  }

  const sendResend = input.sendResend || defaultSendResend;
  const resend = await sendResend({ to, subject, html, text, from, templateId: gate.templateId, label });
  if (resend?.success) {
    await ledger.mark(idempotencyKey, "sent", { provider: "resend", messageId: resend.messageId });
    return { success: true, duplicate: false, provider: "resend", messageId: resend.messageId, fallbackUsed: true };
  }
  if (resend?.uncertain) {
    await ledger.mark(idempotencyKey, "uncertain", { provider: "resend" });
    return { success: false, uncertain: true, fallbackUsed: true, error: "resend_uncertain", provider: "resend" };
  }
  await ledger.mark(idempotencyKey, "failed", { provider: null });
  return {
    success: false,
    error: resend?.error || postmark.error || "delivery_failed",
    fallbackUsed: postmark.configured === true,
    provider: null,
  };
}

module.exports = {
  deliverTransactionalEmail,
  createSqlLedger,
  postmarkConfigured,
  classifyHttpStatus,
};
