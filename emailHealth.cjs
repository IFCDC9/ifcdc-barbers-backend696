/**
 * Email health booleans only.
 * Never read the Postmark token into a response, log, error, or derived string.
 */
function postmarkTokenConfigured() {
  const raw = process.env.POSTMARK_SERVER_TOKEN;
  if (typeof raw !== "string") return false;
  return raw.trim() !== "";
}

function transactionalSenderLoaded() {
  try {
    const delivery = require("./emailDelivery.cjs");
    return typeof delivery.deliverTransactionalEmail === "function";
  } catch {
    return false;
  }
}

function postmarkReadiness() {
  const postmarkConfigured = postmarkTokenConfigured();
  return {
    postmarkConfigured,
    postmarkTransportReady: postmarkConfigured && transactionalSenderLoaded(),
  };
}

module.exports = {
  postmarkReadiness,
};
