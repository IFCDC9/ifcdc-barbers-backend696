/**
 * IFCDC Barbers — i18n entry point.
 *
 * - Bundles en/es + V2 locales (fr, ht, pt, ar, zh-CN, ko, vi).
 * - Fallback language is always English (never blank / raw keys).
 * - MULTI_LANGUAGE_DROPDOWN_V2 gates which languages appear in the picker.
 * - RTL applied only for Arabic.
 */

import { I18nManager } from "react-native";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Localization from "expo-localization";

import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ht from "./locales/ht.json";
import pt from "./locales/pt.json";
import ar from "./locales/ar.json";
import zhCN from "./locales/zh-CN.json";
import ko from "./locales/ko.json";
import vi from "./locales/vi.json";
import {
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  isSupportedLanguage,
  languageMeta,
  normalizeLocale,
  type SupportedLanguageCode,
} from "./languages";

const STORAGE_KEY = "@ifcdc/lang";

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  ht: { translation: ht },
  pt: { translation: pt },
  ar: { translation: ar },
  "zh-CN": { translation: zhCN },
  ko: { translation: ko },
  vi: { translation: vi },
} as const;

function applyRtl(code: SupportedLanguageCode) {
  const wantRtl = languageMeta(code).rtl === true;
  try {
    if (I18nManager.isRTL !== wantRtl) {
      I18nManager.allowRTL(wantRtl);
      I18nManager.forceRTL(wantRtl);
      // RN typically needs a reload for full RTL layout swap; preference is still saved.
    }
  } catch {
    /* ignore */
  }
}

let initialized = false;
function initSync() {
  if (initialized) return;
  initialized = true;
  void i18n.use(initReactI18next).init({
    resources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: Object.keys(resources),
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    parseMissingKeyHandler: (key) => {
      // Never show raw keys — fall back to the key's last segment as last resort
      // (English resource should already cover all keys).
      try {
        const enHit = i18n.getResource("en", "translation", key);
        if (typeof enHit === "string" && enHit) return enHit;
      } catch {
        /* ignore */
      }
      return String(key).split(".").pop() || key;
    },
    compatibilityJSON: "v4",
    react: { useSuspense: false },
  });
}

initSync();

export async function bootstrapI18n(): Promise<SupportedLanguageCode> {
  let target: SupportedLanguageCode = DEFAULT_LANGUAGE;

  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    const fromStore = normalizeLocale(stored);
    if (fromStore) {
      target = fromStore;
    } else {
      const device = detectDeviceLanguage();
      if (device !== DEFAULT_LANGUAGE) target = device;
    }
  } catch {
    /* keep English */
  }

  if (target !== currentLanguage()) {
    try {
      await i18n.changeLanguage(target);
    } catch {
      /* ignore */
    }
  }
  applyRtl(target);
  return target;
}

export function currentLanguage(): SupportedLanguageCode {
  const code = String(i18n.language || DEFAULT_LANGUAGE);
  return normalizeLocale(code) || DEFAULT_LANGUAGE;
}

export async function setLanguage(code: SupportedLanguageCode): Promise<void> {
  if (!isSupportedLanguage(code)) return;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  try {
    await i18n.changeLanguage(code);
  } catch {
    /* ignore */
  }
  applyRtl(code);
}

export async function resetToDeviceLanguage(): Promise<SupportedLanguageCode> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const deviceCode = detectDeviceLanguage();
  try {
    await i18n.changeLanguage(deviceCode);
  } catch {
    /* ignore */
  }
  applyRtl(deviceCode);
  return deviceCode;
}

export function detectDeviceLanguage(): SupportedLanguageCode {
  try {
    const deviceLocales = Localization.getLocales();
    const deviceTag =
      Array.isArray(deviceLocales) && deviceLocales.length > 0
        ? deviceLocales[0]?.languageTag
        : null;
    const deviceCode = normalizeLocale(deviceTag);
    if (deviceCode) return deviceCode;
  } catch {
    /* ignore */
  }
  return DEFAULT_LANGUAGE;
}

export {
  ALL_LANGUAGES,
  SUPPORTED_LANGUAGES,
  getPickerLanguages,
  isSupportedLanguage,
  isPickerLanguage,
  languageMeta,
  DEFAULT_LANGUAGE,
} from "./languages";
export type { SupportedLanguageCode } from "./languages";
export default i18n;
