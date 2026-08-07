/** Default IFCDC Barbers App / AURA public line — do not change Twilio config. */
export const DEFAULT_AURA_PHONE_E164 = "+19895141064";
export const DEFAULT_AURA_PHONE_DISPLAY = "(989) 514-1064";

export function digitsOnly(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

/** Normalize to E.164 for tel: links (US-focused). */
export function toAuraTelHref(phoneRaw?: string | null): string {
  const raw = String(phoneRaw || "").trim();
  if (raw.startsWith("tel:")) return raw;
  if (raw.startsWith("+") && digitsOnly(raw).length >= 11) return `tel:${raw}`;
  const digits = digitsOnly(raw);
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${DEFAULT_AURA_PHONE_E164}`;
}

export function formatUsPhoneDisplay(phoneRaw?: string | null): string {
  const digits = digitsOnly(phoneRaw);
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : "";
  if (national.length === 10) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return DEFAULT_AURA_PHONE_DISPLAY;
}

/**
 * Single-line AURA call label.
 * Default IFCDC: ☎️ Call AURA: (989) 514-1064
 * Other shop: ☎️ Call AURA at [Shop Name]: (XXX) XXX-XXXX
 */
export function buildCallAuraLabel(shopName: string | null | undefined, displayPhone: string): string {
  const display = String(displayPhone || "").trim() || DEFAULT_AURA_PHONE_DISPLAY;
  const name = String(shopName || "").trim();
  const isDefaultIfcdc = !name || /^ifcdc\s+barbers(\s+app)?$/i.test(name);
  if (isDefaultIfcdc) return `☎️ Call AURA: ${display}`;
  return `☎️ Call AURA at ${name}: ${display}`;
}
