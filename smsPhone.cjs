/**
 * Phone normalization for SMS — prefer E.164. US-first with optional default country.
 */
function digitsOnly(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * @param {string} raw
 * @param {{ defaultCountry?: string }} [opts] defaultCountry: "US" → assume +1 when 10 digits
 * @returns {{ ok: true, e164: string, digits: string } | { ok: false, error: string, message: string }}
 */
function normalizeToE164(raw, opts = {}) {
  const input = String(raw || "").trim();
  if (!input) {
    return { ok: false, error: "phone_required", message: "Phone number is required." };
  }
  if (/^\+[1-9]\d{6,14}$/.test(input.replace(/\s/g, ""))) {
    const e164 = input.replace(/\s/g, "");
    return { ok: true, e164, digits: digitsOnly(e164) };
  }
  let d = digitsOnly(input);
  const defaultCountry = String(opts.defaultCountry || process.env.SMS_DEFAULT_COUNTRY || "US")
    .trim()
    .toUpperCase();
  if (defaultCountry === "US" || defaultCountry === "CA") {
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    if (d.length === 10) {
      return { ok: true, e164: `+1${d}`, digits: d };
    }
  }
  if (d.length >= 8 && d.length <= 15) {
    return {
      ok: false,
      error: "phone_needs_country_code",
      message: "Enter phone in international format, e.g. +15551234567.",
    };
  }
  return {
    ok: false,
    error: "phone_invalid",
    message: "Enter a valid phone number in E.164 format (+country…).",
  };
}

function maskPhoneForDisplay(e164OrRaw) {
  const d = digitsOnly(e164OrRaw);
  if (d.length < 4) return "••••";
  return `••••${d.slice(-4)}`;
}

module.exports = {
  digitsOnly,
  normalizeToE164,
  maskPhoneForDisplay,
};
