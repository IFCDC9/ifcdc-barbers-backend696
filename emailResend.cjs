/**
 * Resend only — production sender: MAIL_FROM (verified domain).
 * Env: RESEND_API_KEY (required, re_…), MAIL_FROM (required, e.g. IFCDC Barbers <notifications@ifcdcbarbersapp.com>).
 */
const { Resend } = require("resend");

let _client = null;
let _lastResendKey = "";

/** Verified sending domain for IFCDC production (override with MAIL_FROM_EXPECTED_DOMAIN). */
function getExpectedFromDomain() {
  return String(process.env.MAIL_FROM_EXPECTED_DOMAIN || "ifcdcbarbersapp.com")
    .toLowerCase()
    .trim();
}

/** Trim stray quotes some editors add around .env values; strip CR (Windows line endings). */
function sanitizeEnvLine(value) {
  let s = String(value ?? "").replace(/\r/g, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/\r/g, "").trim();
  }
  if (s.startsWith('"') && !s.endsWith('"')) {
    s = s.slice(1).trim();
  }
  if (s.startsWith("'") && !s.endsWith("'")) {
    s = s.slice(1).trim();
  }
  return s;
}

/** Resend keys are `re_…`. Strip accidental `Bearer ` prefix. */
function normalizeResendApiKey(raw) {
  let k = sanitizeEnvLine(raw);
  if (/^bearer\s+/i.test(k)) {
    k = k.replace(/^bearer\s+/i, "").trim();
  }
  return k.replace(/\r/g, "");
}

function getResendApiKey() {
  return normalizeResendApiKey(process.env.RESEND_API_KEY);
}

function getResend() {
  const key = getResendApiKey();
  if (!key || !key.startsWith("re_")) {
    return null;
  }
  if (/\s/.test(key)) {
    return null;
  }
  if (key !== _lastResendKey) {
    _lastResendKey = key;
    _client = null;
  }
  if (!_client) {
    _client = new Resend(key);
  }
  return _client;
}

/** Canonical From — MAIL_FROM only (no resend.dev fallbacks). */
function getMailFrom() {
  const raw = sanitizeEnvLine(process.env.MAIL_FROM);
  return raw || null;
}

/** @deprecated Use {@link getMailFrom} */
function getDefaultFrom() {
  return getMailFrom();
}

function extractEmailFromFromField(fromLine) {
  const s = sanitizeEnvLine(fromLine);
  if (!s) return "";
  const bracket = s.match(/<([^>]+)>/);
  const inner = bracket ? bracket[1].trim() : s.trim();
  if (!inner.includes("@")) return "";
  return inner;
}

function getDomainFromEmail(email) {
  const i = String(email).lastIndexOf("@");
  return i >= 0 ? String(email).slice(i + 1).toLowerCase().trim() : "";
}

/** Before send: warn if MAIL_FROM domain ≠ expected verified domain. */
function warnIfMailFromDomainMismatch(fromLine) {
  const email = extractEmailFromFromField(fromLine);
  const domain = getDomainFromEmail(email);
  if (!domain) {
    console.warn(
      "[EMAIL] Could not parse address from MAIL_FROM — use: IFCDC Barbers <notifications@ifcdcbarbersapp.com>"
    );
    return;
  }
  const expected = getExpectedFromDomain();
  if (domain !== expected) {
    console.warn(
      `[EMAIL] MAIL_FROM domain "${domain}" does not match expected verified domain "${expected}".`
    );
  }
}

function isResendConfigured() {
  const k = getResendApiKey();
  return Boolean(k && k.startsWith("re_") && !/\s/.test(k));
}

function validateMailFromEnv() {
  return Boolean(getMailFrom());
}

/** Startup checks — Resend keys must be `re_…`, no spaces inside the key line. */
function validateResendEnv() {
  const raw = process.env.RESEND_API_KEY;
  if (raw != null && String(raw) !== String(raw).trim()) {
    console.warn("[email] RESEND_API_KEY has leading/trailing whitespace — fix in backend/.env");
  }
  const k = getResendApiKey();
  if (!k) {
    return false;
  }
  if (String(raw ?? "").includes("\r")) {
    console.warn("[email] RESEND_API_KEY line contained \\r — stripped; save backend/.env with LF line endings if 401 persists");
  }
  if (/\s/.test(k)) {
    console.warn("[email] RESEND_API_KEY contains whitespace — use one line, no spaces, no quotes inside the value");
    return false;
  }
  if (!k.startsWith("re_")) {
    console.warn('[email] RESEND_API_KEY must start with "re_" (https://resend.com/api-keys)');
    return false;
  }
  return true;
}

/**
 * Logs required env status. Does **not** throw — API stays up; email routes return actionable errors.
 */
function logResendProductionEnv() {
  const keyOk = validateResendEnv();
  const mailOk = validateMailFromEnv();
  const mf = getMailFrom();
  console.log("[ENV] RESEND_API_KEY:", keyOk ? "OK" : "MISSING or INVALID");
  console.log("[ENV] MAIL_FROM:", mf || "MISSING");
  if (!keyOk) {
    console.error(
      "[ENV ERROR] Set RESEND_API_KEY=re_… in backend/.env (one line, no spaces). https://resend.com/api-keys"
    );
  }
  if (!mailOk) {
    console.error(
      '[ENV ERROR] Set MAIL_FROM=IFCDC Barbers <notifications@ifcdcbarbersapp.com> in backend/.env (verified domain).'
    );
  } else {
    warnIfMailFromDomainMismatch(mf);
  }
}

/** @deprecated Non-throwing — calls {@link logResendProductionEnv}. */
function assertResendConfigured() {
  logResendProductionEnv();
}

/**
 * Confirms the key works with Resend (GET /domains). **Never throws** — logs a clear error so the API
 * still starts; booking/email routes surface failures without killing the process.
 * Set RESEND_SKIP_VERIFY=1 to skip (offline / CI).
 */
async function verifyResendApiKey() {
  if (process.env.RESEND_SKIP_VERIFY === "1" || process.env.RESEND_SKIP_VERIFY === "true") {
    console.log("[email] RESEND_SKIP_VERIFY — skipping Resend API key check");
    return;
  }
  const key = getResendApiKey();
  if (!key) return;
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    let bodyText = "";
    let bodyJson = null;
    try {
      bodyText = await res.text();
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }
    const detail =
      (bodyJson && typeof bodyJson.message === "string" && bodyJson.message) ||
      bodyText.slice(0, 400);
    const looksLikeBadKey =
      res.status === 401 ||
      res.status === 403 ||
      (res.status === 400 &&
        /api key|invalid|unauthorized|suspended/i.test(`${detail} ${bodyText}`.toLowerCase()));
    if (!res.ok && looksLikeBadKey) {
      console.error(
        "[email] Resend rejected RESEND_API_KEY — API will start but emails will fail until fixed.",
        `HTTP ${res.status}. Create a new key at https://resend.com/api-keys → set RESEND_API_KEY on Render backend696 (and local .env), one line, value starts with re_.`,
        detail,
      );
      return;
    }
    if (!res.ok) {
      console.warn("[email] Resend key verify unexpected status:", res.status, bodyText.slice(0, 200));
      return;
    }
    console.log("[email] Resend API key verified (GET /domains OK)");
  } catch (e) {
    const msg = e?.message || String(e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|getaddrinfo|network/i.test(msg)) {
      console.warn("[email] Could not verify Resend key (network):", msg);
      return;
    }
    console.error("[email] Resend key verify error:", e?.stack || e);
  }
}

function formatToRecipient(to) {
  if (Array.isArray(to)) return to.join(", ");
  return String(to ?? "");
}

function resendErrorMessage(err) {
  if (err == null) return "unknown_error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Resend send with **one retry** on failure.
 * Logs: RESEND_API_KEY / MAIL_FROM status, domain warning, [EMAIL] success, [EMAIL ERROR] on failure.
 */
async function sendResendWithRetry(resend, payload, label = "transactional") {
  const k = getResendApiKey();
  const keyOk = k && k.startsWith("re_") && !/\s/.test(k);
  const mf = getMailFrom();
  console.log(
    `[EMAIL] ${label}: RESEND_API_KEY=${keyOk ? "LOADED" : "MISSING"}, MAIL_FROM=${mf || "MISSING"}`
  );

  if (payload.from) {
    warnIfMailFromDomainMismatch(payload.from);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await resend.emails.send(payload);
      if (response.error) {
        const msg = resendErrorMessage(response.error);
        console.error(`[EMAIL ERROR] ${msg}`);
        console.error(
          `[email] ${label} attempt ${attempt} Resend error (full):`,
          JSON.stringify(response.error, null, 2)
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw new Error(msg);
      }
      const recip = formatToRecipient(payload.to);
      console.log(`[EMAIL] Sent successfully to: ${recip}`);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[EMAIL ERROR] ${msg}`);
      const serialized =
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : err;
      console.error(
        `[email] ${label} attempt ${attempt} exception (full):`,
        err instanceof Error ? err.stack : JSON.stringify(serialized, null, 2)
      );
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(`${label}: send failed after retry`);
}

/**
 * Same Resend stack as GET /api/test-email: `getResend()` (RESEND_API_KEY) + `getMailFrom()` (MAIL_FROM) + `sendResendWithRetry`.
 * Throws if configuration is invalid or Resend fails after retries.
 *
 * @param {string | string[]} to
 * @param {string} subject
 * @param {string} [html]
 * @param {string} [text]
 * @param {string} [label]
 */
async function sendTransactionalEmail(to, subject, html, text, label = "transactional") {
  const resend = getResend();
  if (!resend) {
    throw new Error("RESEND_API_KEY missing or invalid (must start with re_, no spaces)");
  }
  const from = getMailFrom();
  if (!from) {
    throw new Error(
      'MAIL_FROM is not set — add MAIL_FROM=IFCDC Barbers <notifications@ifcdcbarbersapp.com> to backend/.env'
    );
  }
  const safeHtml = html != null && String(html).trim() !== "" ? html : undefined;
  const safeText = text != null && String(text).trim() !== "" ? text : undefined;
  if (!safeHtml && !safeText) {
    throw new Error("sendTransactionalEmail: html or text is required");
  }
  warnIfMailFromDomainMismatch(from);
  return sendResendWithRetry(
    resend,
    {
      from,
      to,
      subject,
      ...(safeHtml ? { html: safeHtml } : {}),
      ...(safeText ? { text: safeText } : {}),
    },
    label
  );
}

/**
 * Single public send API — same stack as GET /api/test-email (`sendTransactionalEmail`).
 * Uses `process.env.RESEND_API_KEY` + `process.env.MAIL_FROM`.
 *
 * @param {{ to: string|string[], subject: string, html?: string, text?: string, label?: string }} params
 * @returns {Promise<{ data?: object, error?: object }>} Resend shape; `error` set when config/send fails (does not throw).
 */
async function sendEmail(params) {
  if (params == null || typeof params !== "object" || Array.isArray(params)) {
    return {
      data: null,
      error: { message: "sendEmail: expected { to, subject, html? }", name: "invalid_args" },
    };
  }
  const { to, subject, html, text, label = "sendEmail" } = params;
  if (to == null || subject == null || String(subject).trim() === "") {
    return {
      data: null,
      error: { message: "sendEmail: to and subject are required", name: "invalid_args" },
    };
  }
  try {
    return await sendTransactionalEmail(to, subject, html, text, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[EMAIL ERROR] ${message}`);
    const code =
      /MAIL_FROM/.test(message) ? 503 : /RESEND_API_KEY/.test(message) ? 400 : 500;
    return { data: null, error: { message, name: "send_exception", statusCode: code } };
  }
}

async function sendEmailMessage({ to, subject, html, text, from, replyTo } = {}) {
  const resend = getResend();
  if (!resend) {
    console.error("[EMAIL ERROR] RESEND_API_KEY not set");
    return { data: null, error: { message: "RESEND_API_KEY not set" } };
  }
  const fromAddr = from || getMailFrom();
  if (!fromAddr) {
    const msg = "MAIL_FROM not set";
    console.error(`[EMAIL ERROR] ${msg}`);
    return { data: null, error: { message: msg, statusCode: 503 } };
  }
  warnIfMailFromDomainMismatch(fromAddr);
  try {
    return await sendResendWithRetry(
      resend,
      {
        from: fromAddr,
        to,
        subject,
        html: html || undefined,
        text: text || undefined,
        reply_to: replyTo || undefined,
      },
      "sendEmailMessage"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[EMAIL ERROR] ${message}`);
    return { data: null, error: { message, name: "send_exception" } };
  }
}

module.exports = {
  getResend,
  getMailFrom,
  getDefaultFrom,
  getExpectedFromDomain,
  warnIfMailFromDomainMismatch,
  sanitizeEnvLine,
  normalizeResendApiKey,
  getResendApiKey,
  isResendConfigured,
  validateResendEnv,
  validateMailFromEnv,
  logResendProductionEnv,
  assertResendConfigured,
  verifyResendApiKey,
  sendTransactionalEmail,
  sendEmail,
  sendEmailMessage,
  sendResendWithRetry,
};
