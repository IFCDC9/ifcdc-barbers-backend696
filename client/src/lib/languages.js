/**
 * Shared language registry for web UI (mirrors mobile/i18n/languages.ts).
 */
export const SUPPORTED_LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English", rtl: false },
  { code: "es", nativeName: "Español", englishName: "Spanish", rtl: false },
];

export const DEFAULT_LANGUAGE = "en";

export function isSupportedLanguage(code) {
  return SUPPORTED_LANGUAGES.some((l) => l.code === String(code || "").toLowerCase());
}
