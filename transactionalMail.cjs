/**
 * Claimed transactional send. Postmark is primary inside deliverTransactionalEmail.
 * Resend runs only when that function decides Postmark explicitly rejected or is unset.
 */
const { deliverTransactionalEmail } = require("./emailDelivery.cjs");

function asError(result) {
  if (result?.success === true) return null;
  const raw = result?.error;
  const message = raw && typeof raw === "object" ? raw.message || "send_failed" : raw || "send_failed";
  return { message: String(message), name: result?.uncertain ? "uncertain" : "send_failed" };
}

async function sendClaimedEmail(input = {}) {
  const result = await deliverTransactionalEmail(input);
  const success = result?.success === true;
  const messageId = result?.messageId || null;
  return {
    ...result,
    ok: success,
    success,
    sent: success,
    id: messageId,
    messageId,
    data: messageId ? { id: messageId } : null,
    error: asError(result),
    delivered: false,
  };
}

module.exports = { sendClaimedEmail };
