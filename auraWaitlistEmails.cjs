/**
 * AURA Phase 3B2 waitlist offer notification emails.
 * Uses existing Resend + MAIL_FROM. No SMS. Test-recipient allowlist by default.
 */
const crypto = require("crypto");
const { sendAuraTemplatedEmail, sendAuraAdminFailureAlert } = require("./auraPhase2Emails.cjs");
const { getMailFrom } = require("./emailResend.cjs");

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asDateOnly(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function resolvePublicWebOrigin() {
  try {
    const { resolvePublicWebOrigin: resolve } = require("./publicSiteConfig.cjs");
    return String(resolve() || "https://ifcdcbarbersapp.com").replace(/\/$/, "");
  } catch {
    return "https://ifcdcbarbersapp.com";
  }
}

function resolveApiOrigin() {
  return String(
    process.env.PUBLIC_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      "https://ifcdc-barbers-backend696.onrender.com",
  ).replace(/\/$/, "");
}

function actionTokenSecret() {
  return String(
    process.env.AURA_WAITLIST_ACTION_SECRET ||
      process.env.AUTH_JWT_SECRET ||
      process.env.JWT_SECRET ||
      "",
  ).trim();
}

function signWaitlistOfferAction({ offerId, customerId, action, expiresAt }) {
  const secret = actionTokenSecret();
  if (!secret) return null;
  const payload = {
    offerId: String(offerId),
    customerId: String(customerId),
    action: String(action),
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyWaitlistOfferActionToken(token) {
  const secret = actionTokenSecret();
  if (!secret) return { ok: false, error: "action_secret_missing" };
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, error: "invalid_token" };
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "invalid_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid_payload" };
  }
  if (!payload?.offerId || !payload?.customerId || !payload?.action) {
    return { ok: false, error: "incomplete_payload" };
  }
  if (Number(payload.exp || 0) * 1000 < Date.now()) {
    return { ok: false, error: "token_expired" };
  }
  if (!["accept", "decline"].includes(String(payload.action))) {
    return { ok: false, error: "invalid_action" };
  }
  return { ok: true, payload };
}

/**
 * Controlled allowlist: only approved test recipients receive mail unless "*".
 * Default: BOOKING_ADMIN_EMAIL / AURA_DAILY_REPORT_TO / service@ifcdc.org
 */
function waitlistNotifyAllowlist() {
  const raw = String(process.env.AURA_WAITLIST_NOTIFY_ALLOWLIST || "").trim();
  if (raw === "*") return { mode: "open" };
  const list = (raw ||
    [
      process.env.BOOKING_ADMIN_EMAIL,
      process.env.AURA_DAILY_REPORT_TO,
      process.env.AURA_TEST_CUSTOMER_EMAIL,
      "service@ifcdc.org",
    ]
      .filter(Boolean)
      .join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { mode: "allowlist", list: [...new Set(list)] };
}

function isApprovedWaitlistNotifyRecipient(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const al = waitlistNotifyAllowlist();
  if (al.mode === "open") return true;
  return al.list.includes(e);
}

function buildWaitlistOfferEmailHtml({
  customerName,
  offer,
  acceptUrl,
  declineUrl,
}) {
  const date = asDateOnly(offer.slotDate || offer.slot_date) || "TBD";
  const time = String(offer.slotTime || offer.slot_time || "TBD").slice(0, 5);
  const price =
    offer.currentPrice != null || offer.current_price != null
      ? Number(offer.currentPrice ?? offer.current_price).toFixed(2)
      : "—";
  const expires = offer.offerExpiresAt || offer.offer_expires_at || "soon";
  return `
<p>Hi ${escapeHtml(customerName || "there")},</p>
<p>An optional open appointment slot matches your waitlist request.</p>
<p><strong>Important:</strong> This slot is <strong>NOT booked</strong> until you confirm the full booking summary in the app. No payment is charged by this message.</p>
<p>Barber: <strong>${escapeHtml(offer.barberName || offer.barber_name || "—")}</strong></p>
<p>Service: <strong>${escapeHtml(offer.serviceName || offer.service_name || "—")}</strong></p>
<p>Date: <strong>${escapeHtml(date)}</strong></p>
<p>Time: <strong>${escapeHtml(time)}</strong></p>
<p>Current price: <strong>$${escapeHtml(price)}</strong></p>
<p>Location: <strong>${escapeHtml(offer.location || "IFCDC Barbers")}</strong></p>
<p>Offer expires: <strong>${escapeHtml(String(expires))}</strong></p>
<p>
  <a href="${escapeHtml(acceptUrl)}">Accept</a>
  &nbsp;|&nbsp;
  <a href="${escapeHtml(declineUrl)}">Decline</a>
</p>
<p style="font-size:12px;color:#666;">Accept and Decline require a valid signed link or your signed-in account. Expired or other customers’ offers cannot be used.</p>
`.trim();
}

async function sendWaitlistOfferEmail({
  to,
  customerName,
  offer,
  acceptUrl,
  declineUrl,
}) {
  if (!getMailFrom()) return { ok: false, error: "MAIL_FROM_missing" };
  const dest = String(to || "").trim();
  if (!isApprovedWaitlistNotifyRecipient(dest)) {
    return { ok: false, error: "recipient_not_allowlisted", sent: false };
  }
  const subject = "Optional open slot from your IFCDC waitlist — not booked yet";
  const out = await sendAuraTemplatedEmail({
    to: dest,
    subject,
    heading: "Optional waitlist slot offer",
    bodyHtml: buildWaitlistOfferEmailHtml({ customerName, offer, acceptUrl, declineUrl }),
    label: "aura-waitlist-offer",
  });
  return out;
}

async function alertWaitlistNotifyFailure(detail) {
  try {
    return await sendAuraAdminFailureAlert({
      kind: "waitlist_notification_failure",
      detail,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  asDateOnly,
  signWaitlistOfferAction,
  verifyWaitlistOfferActionToken,
  waitlistNotifyAllowlist,
  isApprovedWaitlistNotifyRecipient,
  buildWaitlistOfferEmailHtml,
  sendWaitlistOfferEmail,
  alertWaitlistNotifyFailure,
  resolvePublicWebOrigin,
  resolveApiOrigin,
};
