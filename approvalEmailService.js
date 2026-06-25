/**
 * Polished onboarding / approval transactional emails (Resend).
 */
import { createRequire } from "node:module";
import { CANONICAL_SUPER_ADMIN_EMAIL } from "./rolePolicy.js";

const require = createRequire(import.meta.url);
const { sendEmail, isResendConfigured } = require("./emailResend.cjs");

const APP_URL = String(process.env.PUBLIC_WEB_URL || "https://ifcdcbarbersapp.com").replace(/\/+$/, "");
const ADMIN_BARBERS_URL = `${APP_URL}/admin/barbers`;
const ADMIN_SHOPS_URL = `${APP_URL}/admin/shops`;
const LOGIN_URL = `${APP_URL}/login`;
const SUPPORT_EMAIL = CANONICAL_SUPER_ADMIN_EMAIL;

function platformAdminEmail() {
  return String(process.env.BOOKING_ADMIN_EMAIL || CANONICAL_SUPER_ADMIN_EMAIL).trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function formatRoleLabel(role) {
  const r = String(role || "").toLowerCase();
  if (r === "shop_owner") return "Shop Owner";
  if (r === "barber") return "Barber";
  return "User";
}

function formatRegistrationTime(value) {
  if (!value) return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "America/New_York",
  });
}

function emailShell({ title, preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtml(preheader || title)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f0f0f;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;">
        <tr><td style="background:linear-gradient(135deg,#1a1a1a 0%,#252525 100%);padding:24px 28px;border-bottom:3px solid #FFD700;">
          <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#FFD700;font-weight:700;">IFCDC Barbers</p>
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#ffffff;font-weight:700;">${escapeHtml(title)}</h1>
        </td></tr>
        <tr><td style="padding:28px;color:#e8e8e8;font-size:15px;line-height:1.65;">${bodyHtml}</td></tr>
        <tr><td style="padding:0 28px 24px;color:#888;font-size:12px;line-height:1.5;">
          IFCDC Barbers App · <a href="${APP_URL}" style="color:#FFD700;text-decoration:none;">ifcdcbarbersapp.com</a><br>
          Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:#FFD700;text-decoration:none;">${SUPPORT_EMAIL}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function detailRow(label, value) {
  if (value == null || String(value).trim() === "") return "";
  return `<tr>
    <td style="padding:8px 0;color:#aaa;font-size:13px;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:8px 0;color:#fff;font-size:14px;font-weight:600;">${escapeHtml(value)}</td>
  </tr>`;
}

function detailsTable(rows) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;background:#121212;border:1px solid #2a2a2a;border-radius:8px;padding:4px 16px;">${rows.join("")}</table>`;
}

function ctaButton(href, label) {
  return `<p style="margin:24px 0 8px;text-align:center;">
    <a href="${href}" style="display:inline-block;background:#FFD700;color:#111111;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;">${escapeHtml(label)}</a>
  </p>`;
}

async function sendBestEffort({ to, subject, text, html, label }) {
  if (!isResendConfigured()) {
    console.warn(`[approval-email] skipped (${label}) — Resend not configured`);
    return { ok: false, skipped: true, reason: "resend_not_configured" };
  }
  if (!looksLikeEmail(to)) {
    console.warn(`[approval-email] skipped (${label}) — invalid recipient`);
    return { ok: false, skipped: true, reason: "invalid_recipient" };
  }
  const result = await sendEmail({ to, subject, text, html, label });
  if (result?.error) {
    console.warn(`[approval-email] failed (${label}):`, result.error?.message || result.error);
    return { ok: false, error: result.error?.message || "send_failed" };
  }
  console.log(`[approval-email] sent (${label}) → ${to} id=${result?.data?.id || "?"}`);
  return { ok: true, messageId: result?.data?.id || null };
}

export function isApprovalEmailConfigured() {
  return isResendConfigured();
}

/** Super Admin — new barber or shop owner signup awaiting approval. */
export async function emailSuperAdminNewSignupPending({
  role = "barber",
  fullName,
  businessName,
  email,
  phone,
  registeredAt,
  barberId,
  businessId,
  city,
  state,
}) {
  const roleLabel = formatRoleLabel(role);
  const subject = `New ${roleLabel} Awaiting Approval`;
  const registered = formatRegistrationTime(registeredAt);
  const dashboardUrl = role === "shop_owner" ? ADMIN_SHOPS_URL : ADMIN_BARBERS_URL;
  const location = [city, state].filter(Boolean).join(", ");

  const text =
    `A new ${roleLabel.toLowerCase()} registration is awaiting your approval.\n\n` +
    `Full Name: ${fullName || "—"}\n` +
    `Business Name: ${businessName || "—"}\n` +
    `Email: ${email || "—"}\n` +
    `Phone: ${phone || "—"}\n` +
    `Role: ${roleLabel}\n` +
    `Registered: ${registered}\n` +
    `Status: Pending Approval\n\n` +
    `Review in the Admin Approval Dashboard:\n${dashboardUrl}\n`;

  const bodyHtml =
    `<p style="margin:0 0 12px;color:#ccc;">A new registration requires your review in the Super Admin dashboard.</p>` +
    detailsTable(
      [
        detailRow("Full Name", fullName || "—"),
        detailRow("Business Name", businessName || "—"),
        detailRow("Email Address", email || "—"),
        detailRow("Phone Number", phone || "Not provided"),
        detailRow("Selected Role", roleLabel),
        detailRow("Registration Date", registered),
        detailRow("Current Status", "Pending Approval"),
        location ? detailRow("Location", location) : "",
        barberId != null ? detailRow("Barber ID", String(barberId)) : "",
        businessId != null ? detailRow("Business ID", String(businessId)) : "",
      ].filter(Boolean),
    ) +
    ctaButton(dashboardUrl, "Open Admin Approval Dashboard");

  const html = emailShell({
    title: `New ${roleLabel} Awaiting Approval`,
    preheader: `${fullName || "A new user"} registered and is pending approval.`,
    bodyHtml,
  });

  return sendBestEffort({
    to: platformAdminEmail(),
    subject,
    text,
    html,
    label: `super-admin-signup-${role}`,
  });
}

/** @deprecated use emailSuperAdminNewSignupPending */
export async function emailSuperAdminNewBarberPending(params) {
  return emailSuperAdminNewSignupPending({
    role: "barber",
    fullName: params.fullName,
    businessName: params.shopName,
    email: params.email,
    phone: params.phone,
    registeredAt: params.registeredAt,
    barberId: params.barberId,
    city: params.city,
    state: params.state,
  });
}

/** @deprecated use emailSuperAdminNewSignupPending */
export async function emailSuperAdminNewShopOwnerPending(params) {
  return emailSuperAdminNewSignupPending({
    role: "shop_owner",
    fullName: params.ownerName,
    businessName: params.shopName,
    email: params.email,
    phone: params.phone,
    registeredAt: params.registeredAt,
    businessId: params.businessId,
    city: params.city,
    state: params.state,
  });
}

/** User — account approved. */
export async function emailUserAccountApproved({ to, name, role, shopName }) {
  const roleLabel = formatRoleLabel(role);
  const subject = "Welcome to IFCDC Barbers App – Your Account Has Been Approved!";
  const firstName = String(name || "there").trim().split(/\s+/)[0] || "there";

  const text =
    `Hi ${firstName},\n\n` +
    `Congratulations and welcome to IFCDC Barbers!\n\n` +
    `Your ${roleLabel.toLowerCase()} account has been approved and is now active. You can sign in and start using the platform right away.\n` +
    (shopName ? `\nBusiness: ${shopName}\n` : "") +
    `\nSign in: ${LOGIN_URL}\n\n` +
    `Getting Started:\n` +
    `• Sign in with the email address you used to register.\n` +
    `• Complete your profile and business settings.\n` +
    `• ${role === "shop_owner" ? "Manage your shop, barbers, and services from your dashboard." : "Set your services, pricing, and availability."}\n\n` +
    `Support: ${SUPPORT_EMAIL}\n`;

  const bodyHtml =
    `<p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>` +
    `<p style="margin:0 0 16px;"><strong style="color:#FFD700;">Congratulations and welcome!</strong> Your IFCDC Barbers ${escapeHtml(roleLabel)} account has been approved and is now <strong style="color:#fff;">active</strong>.</p>` +
    (shopName ? `<p style="margin:0 0 16px;"><strong>Business:</strong> ${escapeHtml(shopName)}</p>` : "") +
    ctaButton(LOGIN_URL, "Sign In to Your Account") +
    `<h2 style="margin:28px 0 12px;font-size:16px;color:#FFD700;">Getting Started</h2>` +
    `<ul style="margin:0;padding-left:20px;color:#ccc;">` +
    `<li style="margin-bottom:8px;">Sign in with the email address you used to register.</li>` +
    `<li style="margin-bottom:8px;">Complete your profile and business settings.</li>` +
    `<li style="margin-bottom:8px;">${
      role === "shop_owner"
        ? "Manage your shop, barbers, and services from your dashboard."
        : "Set your services, pricing, and availability."
    }</li>` +
    `</ul>` +
    `<p style="margin:20px 0 0;color:#aaa;font-size:14px;">Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#FFD700;">${SUPPORT_EMAIL}</a>.</p>`;

  const html = emailShell({
    title: "Your Account Has Been Approved!",
    preheader: "Welcome to IFCDC Barbers — your account is active.",
    bodyHtml,
  });

  return sendBestEffort({ to, subject, text, html, label: "user-account-approved" });
}

/** User — application not approved. */
export async function emailUserAccountDenied({ to, name, role, shopName, reason }) {
  const roleLabel = formatRoleLabel(role);
  const subject = "Update Regarding Your IFCDC Barbers App Application";
  const firstName = String(name || "there").trim().split(/\s+/)[0] || "there";

  const text =
    `Hi ${firstName},\n\n` +
    `Thank you for your interest in IFCDC Barbers and for taking the time to apply.\n\n` +
    `After careful review, your ${roleLabel.toLowerCase()} application was not approved at this time.` +
    (reason ? `\n\nNote: ${reason}` : "") +
    (shopName ? `\n\nBusiness: ${shopName}` : "") +
    `\n\nIf you have questions or would like additional information, please contact us at ${SUPPORT_EMAIL}.\n\n` +
    `We appreciate your interest in the IFCDC Barbers community.\n`;

  const bodyHtml =
    `<p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>` +
    `<p style="margin:0 0 16px;">Thank you for your interest in IFCDC Barbers and for taking the time to submit your application.</p>` +
    `<p style="margin:0 0 16px;">After careful review, we regret to inform you that your <strong>${escapeHtml(roleLabel)}</strong> application was <strong>not approved at this time</strong>.</p>` +
    (reason ? `<p style="margin:0 0 16px;padding:12px 16px;background:#121212;border-left:3px solid #888;color:#ccc;"><strong>Note:</strong> ${escapeHtml(reason)}</p>` : "") +
    (shopName ? `<p style="margin:0 0 16px;"><strong>Business:</strong> ${escapeHtml(shopName)}</p>` : "") +
    `<p style="margin:0 0 16px;color:#ccc;">If you have questions or would like additional information about this decision, our team is here to help.</p>` +
    `<p style="margin:0;"><a href="mailto:${SUPPORT_EMAIL}" style="color:#FFD700;font-weight:600;">${SUPPORT_EMAIL}</a></p>` +
    `<p style="margin:20px 0 0;color:#888;font-size:14px;">We appreciate your interest in the IFCDC Barbers community.</p>`;

  const html = emailShell({
    title: "Application Update",
    preheader: "An update regarding your IFCDC Barbers application.",
    bodyHtml,
  });

  return sendBestEffort({ to, subject, text, html, label: "user-account-denied" });
}
