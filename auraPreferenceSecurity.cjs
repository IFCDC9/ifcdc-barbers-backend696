/**
 * Phase 3B1 preference input guards — customer text is untrusted.
 */
const { detectPromptInjection, sanitizeCustomerText } = require("./auraKnowledgeSecurity.cjs");

const ALLOWED_PREFERENCE_TYPES = new Set([
  "preferred_barber",
  "preferred_services",
  "preferred_days",
  "preferred_time_ranges",
  "preferred_language",
  "communication_preference",
  "accessibility_notes",
]);

const ALLOWED_DAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const ALLOWED_COMMUNICATION = new Set(["email", "sms", "push", "in_app", "none"]);

const PROHIBITED_CONTENT = [
  /\b(password|passcode|otp|one[-\s]?time\s+code|auth\s*code|2fa|mfa)\b/i,
  /\b(ssn|social\s+security|passport|driver'?s?\s+license|government\s+id)\b/i,
  /\b(credit\s+card|card\s+number|cvv|cvc|iban|routing\s+number|bank\s+account)\b/i,
  /\b(paypal\s+secret|api\s+key|jwt|bearer\s+token)\b/i,
  /\b(diagnos|medical|prescription|disability|hiv|cancer|pregnant|mental\s+health)\b/i,
  /\b(race|religion|ethnicity|sexual\s+orientation|gender\s+identity)\b/i,
  /\b(other\s+customer|someone\s+else'?s|his\s+phone|her\s+ssn)\b/i,
];

function isAllowedPreferenceType(type) {
  return ALLOWED_PREFERENCE_TYPES.has(String(type || "").trim());
}

function detectProhibitedPreferenceContent(text) {
  const s = String(text || "");
  const injection = detectPromptInjection(s);
  if (injection.blocked) return { blocked: true, reason: "prompt_injection" };
  for (const re of PROHIBITED_CONTENT) {
    if (re.test(s)) return { blocked: true, reason: "prohibited_content" };
  }
  return { blocked: false };
}

function normalizePreferenceValue(type, raw) {
  const t = String(type || "").trim();
  if (!isAllowedPreferenceType(t)) {
    return { ok: false, error: "unauthorized_preference_type" };
  }

  if (t === "preferred_barber") {
    const barberId = String(raw?.barberId || raw?.barber_id || raw?.id || "").trim();
    const barberName = sanitizeCustomerText(raw?.barberName || raw?.barber_name || raw?.name || "", 120);
    if (!barberId && !barberName) return { ok: false, error: "barber_required" };
    const check = detectProhibitedPreferenceContent(`${barberId} ${barberName}`);
    if (check.blocked) return { ok: false, error: check.reason };
    return { ok: true, value: { barberId: barberId || null, barberName: barberName || null } };
  }

  if (t === "preferred_services") {
    const list = Array.isArray(raw?.services)
      ? raw.services
      : Array.isArray(raw)
        ? raw
        : String(raw?.service || raw || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    const services = list
      .map((s) => sanitizeCustomerText(typeof s === "string" ? s : s?.name || "", 80))
      .filter(Boolean)
      .slice(0, 12);
    if (!services.length) return { ok: false, error: "services_required" };
    const check = detectProhibitedPreferenceContent(services.join(" "));
    if (check.blocked) return { ok: false, error: check.reason };
    return { ok: true, value: { services } };
  }

  if (t === "preferred_days") {
    const list = Array.isArray(raw?.days) ? raw.days : Array.isArray(raw) ? raw : [raw?.day || raw];
    const days = [
      ...new Set(
        list
          .map((d) => String(d || "").trim().toLowerCase())
          .filter((d) => ALLOWED_DAYS.has(d)),
      ),
    ];
    if (!days.length) return { ok: false, error: "days_required" };
    return { ok: true, value: { days } };
  }

  if (t === "preferred_time_ranges") {
    const ranges = Array.isArray(raw?.ranges) ? raw.ranges : Array.isArray(raw) ? raw : [raw];
    const normalized = [];
    for (const r of ranges.slice(0, 6)) {
      const start = String(r?.start || r?.from || "").trim();
      const end = String(r?.end || r?.to || "").trim();
      if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) continue;
      normalized.push({ start, end, label: sanitizeCustomerText(r?.label || "", 40) || null });
    }
    if (!normalized.length) return { ok: false, error: "time_ranges_required" };
    return { ok: true, value: { ranges: normalized } };
  }

  if (t === "preferred_language") {
    const language = sanitizeCustomerText(raw?.language || raw?.code || raw || "", 32).toLowerCase();
    if (!/^[a-z]{2,8}(-[a-z0-9]{2,8})?$/i.test(language)) {
      return { ok: false, error: "language_invalid" };
    }
    return { ok: true, value: { language } };
  }

  if (t === "communication_preference") {
    const channel = String(raw?.channel || raw?.preference || raw || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_COMMUNICATION.has(channel)) {
      return { ok: false, error: "communication_invalid" };
    }
    return { ok: true, value: { channel } };
  }

  if (t === "accessibility_notes") {
    const notes = sanitizeCustomerText(raw?.notes || raw?.text || raw || "", 400);
    if (!notes) return { ok: false, error: "notes_required" };
    const check = detectProhibitedPreferenceContent(notes);
    if (check.blocked) return { ok: false, error: check.reason };
    return { ok: true, value: { notes } };
  }

  return { ok: false, error: "unauthorized_preference_type" };
}

/**
 * Preferences never override scheduling/pricing/auth. Callers must re-validate slots.
 */
function preferencesCannotOverrideScheduling() {
  return {
    overrideAllowed: false,
    autoBookAllowed: false,
    message:
      "Saved preferences are suggestions only. Availability, pricing, policies, and authorization still apply.",
  };
}

module.exports = {
  ALLOWED_PREFERENCE_TYPES,
  ALLOWED_DAYS,
  ALLOWED_COMMUNICATION,
  isAllowedPreferenceType,
  detectProhibitedPreferenceContent,
  normalizePreferenceValue,
  preferencesCannotOverrideScheduling,
  sanitizeCustomerText,
};
