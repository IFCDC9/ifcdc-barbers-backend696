/**
 * Website i18n — mirrors mobile dictionaries + web chrome namespaces.
 * Feature flag VITE_MULTI_LANGUAGE_DROPDOWN_V2 gates which languages appear
 * in the picker; English/Spanish always available. Fallback is always English.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  ALL_LANGUAGES,
  DEFAULT_LANGUAGE,
  getPickerLanguages,
  isMultiLanguageDropdownV2Enabled,
  normalizeLocale,
} from "../lib/languages.js";

import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ht from "./locales/ht.json";
import pt from "./locales/pt.json";
import ar from "./locales/ar.json";
import he from "./locales/he.json";
import zhCN from "./locales/zh-CN.json";
import ko from "./locales/ko.json";
import vi from "./locales/vi.json";

export const LANG_STORAGE_KEY = "ifcdc_preferred_language";
const MISSING_KEYS = new Set();

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  ht: { translation: ht },
  pt: { translation: pt },
  ar: { translation: ar },
  he: { translation: he },
  "zh-CN": { translation: zhCN },
  ko: { translation: ko },
  vi: { translation: vi },
};

function applyDocumentLanguage(code) {
  try {
    const meta = ALL_LANGUAGES.find((l) => l.code === code) || ALL_LANGUAGES[0];
    const wantRtl = Boolean(meta.rtl);
    document.documentElement.lang = code === "zh-CN" ? "zh-CN" : code;
    // Always set explicitly — never leave a stale rtl dir from a prior Arabic session.
    document.documentElement.setAttribute("dir", wantRtl ? "rtl" : "ltr");
    if (wantRtl) {
      document.body?.classList?.add("ifcdc-rtl");
    } else {
      document.body?.classList?.remove("ifcdc-rtl");
    }
  } catch {
    /* ignore SSR / tests */
  }
}

function readStoredLanguage() {
  try {
    return normalizeLocale(localStorage.getItem(LANG_STORAGE_KEY));
  } catch {
    return null;
  }
}

const initial =
  readStoredLanguage() ||
  normalizeLocale(typeof navigator !== "undefined" ? navigator.language : null) ||
  DEFAULT_LANGUAGE;

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: initial,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: Object.keys(resources),
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    saveMissing: true,
    missingKeyHandler: (_lngs, _ns, key) => {
      if (!MISSING_KEYS.has(key)) {
        MISSING_KEYS.add(key);
        if (typeof console !== "undefined") {
          console.warn("[i18n] missing key → English fallback:", key);
        }
      }
    },
    parseMissingKeyHandler: (key) => {
      try {
        const enHit = i18n.getResource("en", "translation", key);
        if (typeof enHit === "string" && enHit) return enHit;
      } catch {
        /* ignore */
      }
      return String(key).split(".").pop() || key;
    },
    react: { useSuspense: false },
  });
  applyDocumentLanguage(initial);
}

export async function setAppLanguage(code) {
  const normalized = normalizeLocale(code) || DEFAULT_LANGUAGE;
  const picker = getPickerLanguages().map((l) => l.code);
  // Allow restoring previously saved V2 languages even if flag is off.
  const allowed = new Set([...picker, "en", "es", normalized]);
  const next = allowed.has(normalized) ? normalized : DEFAULT_LANGUAGE;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  await i18n.changeLanguage(next);
  applyDocumentLanguage(next);
  return next;
}

export function currentAppLanguage() {
  return normalizeLocale(i18n.language) || DEFAULT_LANGUAGE;
}

export function getMissingTranslationKeys() {
  return [...MISSING_KEYS].sort();
}

export { i18n, isMultiLanguageDropdownV2Enabled, getPickerLanguages, ALL_LANGUAGES };
export default i18n;
