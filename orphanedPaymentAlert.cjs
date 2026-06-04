/**
 * Admin alert when PayPal captured funds but booking finalization failed or is missing.
 */
const { sendEmail, getMailFrom } = require("./emailResend.cjs");

async function sendOrphanedPaymentAdminAlert(payload = {}) {
  const adminTo = String(process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org").trim();
  const from = getMailFrom();
  if (!from || !adminTo) {
    console.error("[orphan-payment] admin alert skipped — MAIL_FROM or BOOKING_ADMIN_EMAIL missing", payload);
    return { ok: false, error: "mail_not_configured" };
  }

  const {
    paypalOrderId = "",
    captureId = "",
    bookingId = "",
    customerEmail = "",
    reason = "unknown",
    capturedUsd = null,
    extra = null,
  } = payload;

  const subject = `[IFCDC URGENT] PayPal captured — booking issue (${reason})`;
  const html = `
<h2>Orphaned / failed booking after PayPal capture</h2>
<p><strong>Reason:</strong> ${escapeHtml(String(reason))}</p>
<p><strong>PayPal Order ID:</strong> ${escapeHtml(String(paypalOrderId || "—"))}</p>
<p><strong>Capture ID:</strong> ${escapeHtml(String(captureId || "—"))}</p>
<p><strong>Booking ID:</strong> ${escapeHtml(String(bookingId || "—"))}</p>
<p><strong>Customer email:</strong> ${escapeHtml(String(customerEmail || "—"))}</p>
<p><strong>Captured USD:</strong> ${capturedUsd != null ? escapeHtml(String(capturedUsd)) : "—"}</p>
${extra ? `<pre style="font-size:12px;background:#f4f4f4;padding:12px;">${escapeHtml(JSON.stringify(extra, null, 2).slice(0, 4000))}</pre>` : ""}
<p>Check Render logs for <code>[app-bookings] finalize</code> and reconcile in Supabase/Postgres bookings.</p>
  `.trim();

  try {
    const result = await sendEmail({
      to: adminTo,
      subject,
      html,
      text: html.replace(/<[^>]+>/g, " "),
      label: "orphaned-payment-admin",
    });
    if (result.error) {
      console.error("[orphan-payment] admin alert send FAILED:", result.error?.message || result.error);
      return { ok: false, error: result.error?.message || "send_failed" };
    }
    console.log("[orphan-payment] admin alert SENT", { to: adminTo, paypalOrderId, bookingId, reason });
    return { ok: true, messageId: result.data?.id };
  } catch (e) {
    console.error("[orphan-payment] admin alert FAILED:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { sendOrphanedPaymentAdminAlert };
