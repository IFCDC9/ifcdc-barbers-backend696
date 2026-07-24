/**
 * Review system emails — new review → barber; report/hide/remove → Super Admin.
 * Best-effort; never throws to callers.
 */
const { sendEmail } = require("./emailResend.cjs");

const ADMIN_REVIEW_EMAIL = String(process.env.REVIEW_ADMIN_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org")
  .trim()
  .toLowerCase();

const WEB_URL = String(process.env.PUBLIC_WEB_URL || process.env.EXPO_PUBLIC_WEB_URL || "https://ifcdcbarbersapp.com")
  .trim()
  .replace(/\/$/, "");

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function starsText(rating) {
  const n = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

async function resolveBarberContact(dbQuery, barberId) {
  const id = String(barberId || "").trim();
  if (!id) return { name: "Provider", emails: [] };
  const emails = new Set();
  let name = "Provider";
  try {
    const br = await dbQuery(
      `SELECT b.name, u.email AS owner_email
       FROM barbers b
       LEFT JOIN app_users u ON u.id = b.user_id
       WHERE b.id::text = $1::text
       LIMIT 1`,
      [id],
    );
    const row = br.rows?.[0];
    if (row?.name) name = String(row.name);
    if (row?.owner_email) emails.add(String(row.owner_email).trim().toLowerCase());
  } catch {
    /* ignore */
  }
  try {
    const ur = await dbQuery(
      `SELECT email FROM app_users
       WHERE role IN ('barber', 'shop_owner')
         AND barber_id::text = $1::text
         AND email IS NOT NULL`,
      [id],
    );
    for (const row of ur.rows || []) {
      if (row.email) emails.add(String(row.email).trim().toLowerCase());
    }
  } catch {
    /* ignore */
  }
  return {
    name,
    emails: [...emails].filter((e) => e.includes("@") && !/@ifcdc\.local$/i.test(e)),
  };
}

async function emailBarberNewReview({ dbQuery, barberId, rating, comment, customerName }) {
  try {
    const contact = await resolveBarberContact(dbQuery, barberId);
    if (!contact.emails.length) {
      console.warn("[review-email] no barber email for", barberId);
      return { ok: false, reason: "no_barber_email" };
    }
    const stars = starsText(rating);
    const who = escapeHtml(customerName || "A verified client");
    const body = escapeHtml(String(comment || "").trim() || "(No written comment)");
    const subject = `New ${Math.round(Number(rating) || 0)}★ review for ${contact.name}`;
    const html =
      `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
      `<p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b8860b;font-weight:700;">IFCDC Barbers</p>` +
      `<h2 style="margin:0 0 12px;">You received a new review</h2>` +
      `<p><strong>${who}</strong> rated <strong>${escapeHtml(contact.name)}</strong></p>` +
      `<p style="font-size:22px;color:#b8860b;margin:8px 0;">${stars}</p>` +
      `<p style="white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:8px;">${body}</p>` +
      `<p style="margin-top:16px;"><a href="${WEB_URL}/profile/rate-me" style="color:#b8860b;">Open IFCDC Barbers</a> to view and reply.</p>` +
      `</div>`;
    const results = [];
    for (const to of contact.emails) {
      results.push(await sendEmail({ to, subject, html, label: "review_new_to_barber" }));
    }
    return { ok: true, results };
  } catch (e) {
    console.warn("[review-email] barber notify failed:", e?.message || e);
    return { ok: false, reason: e?.message || "send_failed" };
  }
}

async function emailCustomerReviewPrompt({
  to,
  customerName,
  barberName,
  bookingId,
  deepLinkWeb,
  deepLinkApp,
  language,
  userId,
}) {
  try {
    const email = String(to || "").trim();
    if (!email.includes("@")) return { ok: false, reason: "no_customer_email" };
    const { customerEmailLabels, tLabel } = require("./customerEmailI18n.cjs");
    let lang = language;
    if (!lang) {
      try {
        const { resolveCustomerLanguage } = await import("./customerLanguage.js");
        lang = await resolveCustomerLanguage({
          userId: userId || null,
          customerEmail: email,
          explicitLanguage: language || null,
        });
      } catch {
        lang = "en";
      }
    }
    const labels = customerEmailLabels(lang);
    const barber = barberName || "your barber";
    const subject = tLabel(labels, "reviewSubject", { barber });
    const reviewUrl =
      deepLinkWeb ||
      `${WEB_URL}/profile/bookings/${encodeURIComponent(String(bookingId || ""))}/review`;
    const appLink = deepLinkApp || `ifcdc-barbers://review/${encodeURIComponent(String(bookingId || ""))}`;
    const html =
      `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
      `<p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b8860b;font-weight:700;">IFCDC Barbers</p>` +
      `<h2 style="margin:0 0 12px;">${escapeHtml(tLabel(labels, "reviewTitle"))}</h2>` +
      `<p>${escapeHtml(tLabel(labels, "reviewHi", { name: customerName || "there" }))}</p>` +
      `<p>${tLabel(labels, "reviewBody", { barber: escapeHtml(barber) })}</p>` +
      `<p style="margin:20px 0;"><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#111;color:#FFD700;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;">${escapeHtml(tLabel(labels, "reviewCta"))}</a></p>` +
      `<p style="color:#666;font-size:13px;">${escapeHtml(tLabel(labels, "reviewAppLink"))} <a href="${escapeHtml(appLink)}">${escapeHtml(appLink)}</a></p>` +
      `<p style="color:#666;font-size:13px;">${escapeHtml(tLabel(labels, "reviewNote"))}</p>` +
      `</div>`;
    return await sendEmail({ to: email, subject, html, label: "review_prompt_customer" });
  } catch (e) {
    console.warn("[review-email] customer prompt failed:", e?.message || e);
    return { ok: false, reason: e?.message || "send_failed" };
  }
}

async function emailAdminReviewModeration({
  action,
  targetType,
  targetId,
  bookingId,
  reason,
  details,
  barberName,
  shopName,
  customerName,
  customerEmail,
  rating,
  comment,
  photoUrls,
  adminNotes,
  adminUserId,
}) {
  try {
    const subject = `[IFCDC Reviews] ${String(action || "update").toUpperCase()} — ${targetType || "content"}`;
    const photos = Array.isArray(photoUrls) ? photoUrls.filter(Boolean) : [];
    const photoHtml = photos.length
      ? `<li><strong>Photos:</strong><ul>${photos
          .map((u) => `<li><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></li>`)
          .join("")}</ul></li>`
      : "";
    const html =
      `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
      `<p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#b8860b;font-weight:700;">IFCDC Barbers · Moderation</p>` +
      `<h2 style="margin:0 0 12px;">Review content ${escapeHtml(action || "updated")}</h2>` +
      `<ul>` +
      `<li><strong>Action:</strong> ${escapeHtml(action)}</li>` +
      `<li><strong>Type:</strong> ${escapeHtml(targetType)}</li>` +
      `<li><strong>Review ID:</strong> ${escapeHtml(targetId)}</li>` +
      `<li><strong>Booking ID:</strong> ${escapeHtml(bookingId || "—")}</li>` +
      `<li><strong>Client:</strong> ${escapeHtml(customerName || "—")} (${escapeHtml(customerEmail || "—")})</li>` +
      `<li><strong>Barber:</strong> ${escapeHtml(barberName || "—")}</li>` +
      `<li><strong>Shop:</strong> ${escapeHtml(shopName || "—")}</li>` +
      `<li><strong>Stars:</strong> ${escapeHtml(rating != null ? String(rating) : "—")} ${rating != null ? starsText(rating) : ""}</li>` +
      `<li><strong>Review text:</strong> ${escapeHtml(comment || "—")}</li>` +
      photoHtml +
      `<li><strong>Reason:</strong> ${escapeHtml(reason || "—")}</li>` +
      `<li><strong>Details:</strong> ${escapeHtml(details || "—")}</li>` +
      `<li><strong>Admin notes:</strong> ${escapeHtml(adminNotes || "—")}</li>` +
      `<li><strong>Admin user:</strong> ${escapeHtml(adminUserId || "—")}</li>` +
      `<li><strong>Date/time:</strong> ${escapeHtml(new Date().toISOString())}</li>` +
      `</ul>` +
      `<p><a href="${WEB_URL}/admin/content-moderation">Open Admin Content Moderation</a></p>` +
      `</div>`;
    return await sendEmail({
      to: ADMIN_REVIEW_EMAIL,
      subject,
      html,
      label: "review_moderation_admin",
    });
  } catch (e) {
    console.warn("[review-email] admin notify failed:", e?.message || e);
    return { ok: false, reason: e?.message || "send_failed" };
  }
}

module.exports = {
  ADMIN_REVIEW_EMAIL,
  emailBarberNewReview,
  emailCustomerReviewPrompt,
  emailAdminReviewModeration,
  resolveBarberContact,
};
