/**
 * Shared language registry for web UI (mirrors mobile/i18n/languages.ts).
 * Picker contents gated by VITE_MULTI_LANGUAGE_DROPDOWN_V2 (default OFF).
 */

export const ALL_LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English", rtl: false },
  { code: "es", nativeName: "Español", englishName: "Spanish", rtl: false },
  { code: "fr", nativeName: "Français", englishName: "French", rtl: false },
  { code: "ht", nativeName: "Kreyòl Ayisyen", englishName: "Haitian Creole", rtl: false },
  { code: "pt", nativeName: "Português", englishName: "Portuguese", rtl: false },
  { code: "ar", nativeName: "العربية", englishName: "Arabic", rtl: true },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Chinese — Simplified", rtl: false },
  { code: "ko", nativeName: "한국어", englishName: "Korean", rtl: false },
  { code: "vi", nativeName: "Tiếng Việt", englishName: "Vietnamese", rtl: false },
];

export const DEFAULT_LANGUAGE = "en";

const PHASE1 = ["en", "es"];
const V2 = ALL_LANGUAGES.map((l) => l.code);

export function isMultiLanguageDropdownV2Enabled() {
  try {
    const v = String(import.meta.env?.VITE_MULTI_LANGUAGE_DROPDOWN_V2 || "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  } catch {
    return false;
  }
}

export function getPickerLanguages() {
  const allowed = new Set(isMultiLanguageDropdownV2Enabled() ? V2 : PHASE1);
  return ALL_LANGUAGES.filter((l) => allowed.has(l.code));
}

/** Back-compat — prefer getPickerLanguages(). */
export const SUPPORTED_LANGUAGES = ALL_LANGUAGES.filter((l) => PHASE1.includes(l.code));

export function isSupportedLanguage(code) {
  const c = String(code || "");
  return ALL_LANGUAGES.some((l) => l.code === c || l.code.toLowerCase() === c.toLowerCase());
}

export function normalizeLocale(raw) {
  if (!raw) return null;
  let tag = String(raw).trim().replace(/_/g, "-");
  if (/^zh(-cn|-hans)?$/i.test(tag)) return "zh-CN";
  const lower = tag.toLowerCase();
  const exact = ALL_LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const primary = lower.split("-")[0];
  if (primary === "zh") return "zh-CN";
  const hit = ALL_LANGUAGES.find((l) => l.code === primary);
  return hit ? hit.code : null;
}
