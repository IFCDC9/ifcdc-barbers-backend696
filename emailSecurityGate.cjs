/**
 * IFCDC Barbers — production email security gate.
 * Blocks free-form / parcel / delivery / marketing / batch abuse.
 * Every outbound Resend send MUST pass an approved templateId.
 */
const fs = require("fs");
const path = require("path");

/** Approved transactional template IDs only. */
const APPROVED_TEMPLATE_IDS = Object.freeze({
  account_verification: {
    id: "account_verification",
    subjectAllow: [/verif/i, /confirm.*(email|account)/i, /one[- ]time|otp|code/i],
  },
  password_reset: {
    id: "password_reset",
    subjectAllow: [/reset/i, /password/i, /recover/i],
  },
  booking_confirmation: {
    id: "booking_confirmation",
    subjectAllow: [/booking/i, /appointment/i, /confirm/i, /reserva/i, /\[IFCDC\]/i],
  },
  booking_reschedule: {
    id: "booking_reschedule",
    subjectAllow: [/reschedul/i, /appointment/i, /cita/i],
  },
  booking_cancellation: {
    id: "booking_cancellation",
    subjectAllow: [/cancel/i, /appointment/i, /cita/i],
  },
  booking_cancel_reschedule: {
    id: "booking_cancel_reschedule",
    subjectAllow: [/cancel/i, /reschedul/i, /booking/i, /appointment/i],
  },
  payment_receipt: {
    id: "payment_receipt",
    subjectAllow: [
      /payment/i,
      /receipt/i,
      /refund/i,
      /paid/i,
      /reembolso|remboursement|remèsman|החזר|退款|환불|hoàn tiền|استرداد/i,
    ],
  },
  appointment_reminder: {
    id: "appointment_reminder",
    subjectAllow: [
      /remind/i,
      /appointment/i,
      /booking/i,
      /recordatorio|cita|rappel|rendez|rapèl|randevou|lembrete|consulta|תזכורת|התור|提醒|预约|알림|예약|nhắc|lịch hẹn|تذكير|موعد/i,
    ],
  },
  admin_notice: {
    id: "admin_notice",
    subjectAllow: [/IFCDC/i, /admin/i, /invite/i, /contact/i, /system test/i],
  },
  barber_notification: {
    id: "barber_notification",
    subjectAllow: [/IFCDC/i, /appointment/i, /assigned/i, /cancel/i, /reschedul/i],
  },
  barber_review: {
    id: "barber_review",
    subjectAllow: [/review/i, /IFCDC/i],
  },
  review_followup: {
    id: "review_followup",
    subjectAllow: [/visit/i, /review/i, /IFCDC/i, /rate/i],
  },
  review_prompt: {
    id: "review_prompt",
    subjectAllow: [
      /rate/i,
      /review/i,
      /califica|notez|nòt|avalie|قيّم|דרגו|评价|평가|đánh giá/i,
      /complet|termin|conclu|fini|اكتمل|הושלם|已完成|완료|hoàn tất/i,
    ],
  },
  signup_pending: {
    id: "signup_pending",
    subjectAllow: [/awaiting approval/i, /approval/i, /IFCDC/i],
  },
  account_approved: {
    id: "account_approved",
    subjectAllow: [/approved/i, /welcome/i, /IFCDC/i],
  },
  account_denied: {
    id: "account_denied",
    subjectAllow: [/IFCDC/i, /application/i],
  },
  waitlist_offer: {
    id: "waitlist_offer",
    subjectAllow: [/waitlist/i, /IFCDC/i],
  },
  founder_notice: {
    id: "founder_notice",
    subjectAllow: [/AURA/i, /IFCDC/i, /founder/i],
  },
  founder_daily_report: {
    id: "founder_daily_report",
    subjectAllow: [/daily report/i, /IFCDC/i],
  },
  operational_digest: {
    id: "operational_digest",
    subjectAllow: [/operational insights/i, /digest/i, /AURA/i],
  },
  starter_welcome: {
    id: "starter_welcome",
    subjectAllow: [/IFCDC/i],
  },
  admin_invite: {
    id: "admin_invite",
    subjectAllow: [/invite/i, /IFCDC/i],
  },
});

const BLOCKED_SUBJECT_PATTERNS = [
  /\bparcel\b/i,
  /\bpackage\b/i,
  /\bshipment\b/i,
  /\btracking\b/i,
  /\bdelivery support\b/i,
  /\bcourier\b/i,
  /\bdhl\b/i,
  /\bups\b/i,
  /\bfedex\b/i,
  /\bDH\d{3,}/i,
  /\bavailable for rescheduling\b/i,
  /\bmarketing\b/i,
  /\bnewsletter\b/i,
  /\bpromo(tion)?\b/i,
];

const BLOCKED_BODY_PATTERNS = [
  /\bparcel\b/i,
  /\bpackage tracking\b/i,
  /\bdelivery support\b/i,
  /\bjordan\.c\b/i,
  /\bnoreply@ifcdcbarbersapp\.com\b/i,
];

/** Per-process rate limit: max sends per recipient per window. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_RECIPIENT = Number(process.env.EMAIL_RATE_LIMIT_PER_MIN || 8);
const RATE_LIMIT_MAX_GLOBAL = Number(process.env.EMAIL_RATE_LIMIT_GLOBAL_PER_MIN || 60);

const _rateByRecipient = new Map();
let _globalHits = [];

function isBatchSendDisabled() {
  return process.env.EMAIL_ALLOW_BATCH_SEND !== "true";
}

function isFreeFormDisabled() {
  return process.env.EMAIL_ALLOW_FREEFORM !== "true";
}

function isProductionLike() {
  return (
    process.env.NODE_ENV === "production"
    || process.env.RENDER === "true"
    || Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function normalizeTemplateId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

function mapLegacyLabelToTemplateId(label) {
  const l = String(label || "").toLowerCase();
  if (/password|reset|recover/.test(l)) return "password_reset";
  if (/verif|otp|invite/.test(l)) return /invite/.test(l) ? "admin_notice" : "account_verification";
  if (/remind/.test(l)) return "appointment_reminder";
  if (/payment|refund|receipt|paid/.test(l)) return "payment_receipt";
  if (/reschedul/.test(l)) return "booking_reschedule";
  if (/cancel/.test(l)) return "booking_cancellation";
  if (/booking|appointment|confirm/.test(l)) return "booking_confirmation";
  if (/contact|admin|test-email|system test|invite/.test(l)) return "admin_notice";
  return null;
}

function listApprovedTemplateIds() {
  return Object.keys(APPROVED_TEMPLATE_IDS);
}

function assertNotBlockedContent(subject, html, text) {
  const hay = `${subject || ""}\n${html || ""}\n${text || ""}`;
  for (const re of BLOCKED_SUBJECT_PATTERNS) {
    if (re.test(String(subject || ""))) {
      return { ok: false, error: `Blocked subject pattern: ${re}` };
    }
  }
  for (const re of BLOCKED_BODY_PATTERNS) {
    if (re.test(hay)) {
      return { ok: false, error: `Blocked body pattern: ${re}` };
    }
  }
  return { ok: true };
}

function assertRecipientAuthorized(to) {
  const list = Array.isArray(to) ? to : [to];
  const emails = list
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return { ok: false, error: "Recipient required" };

  const allowRaw = String(process.env.EMAIL_RECIPIENT_ALLOWLIST || "").trim();
  if (allowRaw) {
    const allow = new Set(
      allowRaw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    for (const e of emails) {
      if (!allow.has(e)) {
        return { ok: false, error: `Recipient not on EMAIL_RECIPIENT_ALLOWLIST: ${e}` };
      }
    }
  }

  // Always reject obvious noreply-as-recipient spoof patterns for parcel campaigns.
  for (const e of emails) {
    if (e === "noreply@ifcdcbarbersapp.com") {
      return { ok: false, error: "noreply@ifcdcbarbersapp.com is not a valid recipient" };
    }
  }
  return { ok: true, emails };
}

function assertRateLimit(emails) {
  const now = Date.now();
  _globalHits = _globalHits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (_globalHits.length + emails.length > RATE_LIMIT_MAX_GLOBAL) {
    return { ok: false, error: "Global email rate limit exceeded" };
  }
  for (const e of emails) {
    const prev = (_rateByRecipient.get(e) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (prev.length + 1 > RATE_LIMIT_MAX_PER_RECIPIENT) {
      return { ok: false, error: `Recipient rate limit exceeded: ${e}` };
    }
    prev.push(now);
    _rateByRecipient.set(e, prev);
  }
  for (let i = 0; i < emails.length; i++) _globalHits.push(now);
  return { ok: true };
}

function appendAudit(entry) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const dir = path.join(__dirname, "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "email-security-audit.jsonl");
    const line = JSON.stringify({
      ...entry,
      at: new Date().toISOString(),
      env: process.env.NODE_ENV || "unknown",
      render: Boolean(process.env.RENDER),
    });
    fs.appendFileSync(file, `${line}\n`);
  } catch (err) {
    console.error("[EMAIL SECURITY] audit write failed:", err instanceof Error ? err.message : err);
  }
  console.log(
    `[EMAIL SECURITY] ${entry.allowed ? "ALLOW" : "DENY"} template=${entry.templateId || "none"} to=${entry.to} subject=${String(entry.subject || "").slice(0, 80)} reason=${entry.reason || "ok"}`
  );
}

/**
 * Gate every outbound email. Call before resend.emails.send / batch.
 * @returns {{ ok: true, templateId: string } | { ok: false, error: string }}
 */
function authorizeOutboundEmail(opts = {}) {
  const subject = String(opts.subject || "");
  const html = opts.html != null ? String(opts.html) : "";
  const text = opts.text != null ? String(opts.text) : "";
  const label = opts.label || opts.templateId || "";
  let templateId = normalizeTemplateId(opts.templateId);

  if (opts.batch === true || opts.isBatch === true) {
    if (isBatchSendDisabled()) {
      const result = { ok: false, error: "Batch email send is disabled until security review (EMAIL_ALLOW_BATCH_SEND)." };
      appendAudit({ allowed: false, reason: result.error, subject, to: opts.to, templateId });
      return result;
    }
  }

  if (!templateId) {
    templateId = mapLegacyLabelToTemplateId(label) || "";
  }

  if (!templateId || !APPROVED_TEMPLATE_IDS[templateId]) {
    const result = {
      ok: false,
      error:
        `Approved templateId required. Allowed: ${listApprovedTemplateIds().join(", ")}. Free-form / unapproved templates are blocked.`,
    };
    appendAudit({ allowed: false, reason: result.error, subject, to: opts.to, templateId: templateId || null });
    return result;
  }

  if (isFreeFormDisabled() && opts.freeForm === true) {
    const result = { ok: false, error: "Free-form email is disabled (EMAIL_ALLOW_FREEFORM)." };
    appendAudit({ allowed: false, reason: result.error, subject, to: opts.to, templateId });
    return result;
  }

  const content = assertNotBlockedContent(subject, html, text);
  if (!content.ok) {
    appendAudit({ allowed: false, reason: content.error, subject, to: opts.to, templateId });
    return content;
  }

  const tmpl = APPROVED_TEMPLATE_IDS[templateId];
  const subjectOk = (tmpl.subjectAllow || []).some((re) => re.test(subject));
  if (!subjectOk && isProductionLike()) {
    // Soft-fail to deny in production when subject does not match template family.
    const result = {
      ok: false,
      error: `Subject does not match approved template family '${templateId}'`,
    };
    appendAudit({ allowed: false, reason: result.error, subject, to: opts.to, templateId });
    return result;
  }

  const recip = assertRecipientAuthorized(opts.to);
  if (!recip.ok) {
    appendAudit({ allowed: false, reason: recip.error, subject, to: opts.to, templateId });
    return recip;
  }

  const rate = assertRateLimit(recip.emails);
  if (!rate.ok) {
    appendAudit({ allowed: false, reason: rate.error, subject, to: opts.to, templateId });
    return rate;
  }

  appendAudit({
    allowed: true,
    reason: "ok",
    subject,
    to: recip.emails.join(","),
    templateId,
    from: opts.from || null,
  });
  return { ok: true, templateId };
}

function assertBatchSendBlocked() {
  if (isBatchSendDisabled()) {
    throw new Error("resend.batch.send is disabled until security review. Set EMAIL_ALLOW_BATCH_SEND=true only after Founder approval.");
  }
}

module.exports = {
  APPROVED_TEMPLATE_IDS,
  authorizeOutboundEmail,
  assertBatchSendBlocked,
  listApprovedTemplateIds,
  mapLegacyLabelToTemplateId,
  isBatchSendDisabled,
  isFreeFormDisabled,
  isProductionLike,
};
