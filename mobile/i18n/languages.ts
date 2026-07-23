/**
 * IFCDC Barbers — supported languages registry.
 *
 * Flag OFF → picker shows English + Spanish only.
 * MULTI_LANGUAGE_DROPDOWN_V2 ON → all nine customer languages.
 */

import {
  isMultiLanguageDropdownV2Enabled,
  MULTI_LANGUAGE_CODES,
  PHASE1_LANGUAGE_CODES,
  normalizePreferredLanguage as sharedNormalize,
} from "./featureFlag";

export type SupportedLanguageCode =
  | "en"
  | "es"
  | "fr"
  | "ht"
  | "pt"
  | "ar"
  | "zh-CN"
  | "ko"
  | "vi";

export type LanguageMeta = {
  code: SupportedLanguageCode;
  nativeName: string;
  englishName: string;
  rtl: boolean;
};

export const ALL_LANGUAGES: readonly LanguageMeta[] = [
  { code: "en", nativeName: "English", englishName: "English", rtl: false },
  { code: "es", nativeName: "Español", englishName: "Spanish", rtl: false },
  { code: "fr", nativeName: "Français", englishName: "French", rtl: false },
  { code: "ht", nativeName: "Kreyòl Ayisyen", englishName: "Haitian Creole", rtl: false },
  { code: "pt", nativeName: "Português", englishName: "Portuguese", rtl: false },
  { code: "ar", nativeName: "العربية", englishName: "Arabic", rtl: true },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Chinese — Simplified", rtl: false },
  { code: "ko", nativeName: "한국어", englishName: "Korean", rtl: false },
  { code: "vi", nativeName: "Tiếng Việt", englishName: "Vietnamese", rtl: false },
] as const;

export const DEFAULT_LANGUAGE: SupportedLanguageCode = "en";
export const FALLBACK_LANGUAGE: SupportedLanguageCode = "en";

export function getPickerLanguages(): readonly LanguageMeta[] {
  const v2 = isMultiLanguageDropdownV2Enabled();
  const allowed = new Set<string>(v2 ? MULTI_LANGUAGE_CODES : PHASE1_LANGUAGE_CODES);
  return ALL_LANGUAGES.filter((l) => allowed.has(l.code));
}

/** Back-compat: phase-1 list used by older imports. Prefer getPickerLanguages(). */
export const SUPPORTED_LANGUAGES: readonly LanguageMeta[] = ALL_LANGUAGES.filter((l) =>
  (PHASE1_LANGUAGE_CODES as readonly string[]).includes(l.code),
);

export function isSupportedLanguage(code: string | null | undefined): code is SupportedLanguageCode {
  if (!code) return false;
  return ALL_LANGUAGES.some((l) => l.code === code || l.code.toLowerCase() === String(code).toLowerCase());
}

export function isPickerLanguage(code: string | null | undefined): boolean {
  return getPickerLanguages().some(
    (l) => l.code === code || l.code.toLowerCase() === String(code || "").toLowerCase(),
  );
}

export function normalizeLocale(raw: string | null | undefined): SupportedLanguageCode | null {
  // allowV2 true so a previously saved V2 preference still restores without data loss
  const n = sharedNormalize(raw, { allowV2: true });
  if (n && isSupportedLanguage(n)) return n;
  return null;
}

export function languageMeta(code: string | null | undefined): LanguageMeta {
  const n = normalizeLocale(code) || DEFAULT_LANGUAGE;
  return ALL_LANGUAGES.find((l) => l.code === n) || ALL_LANGUAGES[0];
}
