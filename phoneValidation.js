/** Shared signup phone validation (US-first, accepts 10-digit or +1). */

export function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

export function formatUsPhoneDisplay(digits10) {
  const d = String(digits10 || "").replace(/\D/g, "");
  if (d.length !== 10) return d;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * @returns {{ ok: true, digits: string, display: string } | { ok: false, error: string, message: string }}
 */
export function validateSignupPhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw) {
    return { ok: false, error: "phone_required", message: "Phone number is required." };
  }

  let digits = normalizePhoneDigits(raw);
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    return {
      ok: false,
      error: "phone_invalid",
      message: "Enter a valid 10-digit phone number (e.g. 555-123-4567).",
    };
  }

  return { ok: true, digits, display: formatUsPhoneDisplay(digits) };
}
