/** Client-side MULTI_LANGUAGE_DROPDOWN_V2 gate (Expo public env). Default OFF. */
export function isMultiLanguageDropdownV2Enabled(): boolean {
  const raw =
    (typeof process !== "undefined" && process.env?.EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2) ||
    (typeof process !== "undefined" && process.env?.MULTI_LANGUAGE_DROPDOWN_V2) ||
    "";
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const MULTI_LANGUAGE_CODES = [
  "en",
  "es",
  "fr",
  "ht",
  "pt",
  "ar",
  "zh-CN",
  "ko",
  "vi",
] as const;

export const PHASE1_LANGUAGE_CODES = ["en", "es"] as const;

export function normalizePreferredLanguage(
  raw: string | null | undefined,
  { allowV2 = false }: { allowV2?: boolean } = {},
): string | null {
  if (!raw) return null;
  const allowed = allowV2 ? MULTI_LANGUAGE_CODES : PHASE1_LANGUAGE_CODES;
  let tag = String(raw).trim().replace(/_/g, "-");
  if (/^zh(-cn|-hans)?$/i.test(tag)) {
    return (allowed as readonly string[]).includes("zh-CN") ? "zh-CN" : null;
  }
  const lower = tag.toLowerCase();
  const exact = (allowed as readonly string[]).find((c) => c.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split("-")[0];
  if (primary === "zh" && (allowed as readonly string[]).includes("zh-CN")) return "zh-CN";
  if ((allowed as readonly string[]).includes(primary)) return primary;
  return null;
}
