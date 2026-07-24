/**
 * Global layout direction control for IFCDC Barbers.
 *
 * Root cause of the mirrored-app bug: I18nManager.forceRTL(true) flips the
 * ENTIRE native layout and can stick across English sessions until cleared.
 *
 * Production policy (Build 72 hotfix):
 * - Native layout is ALWAYS LTR for every language (including Arabic).
 * - Arabic / other RTL languages still receive translated strings.
 * - Document `dir` on the website still switches for Arabic text pages.
 *
 * Why disable native RTL flipping for now:
 * - forceRTL requires a process reload to fully apply, and sticky RTL was
 *   mirroring Home, Booking, Calendar, Profile, Admin, and nav for English.
 * - Restoring LTR for the release candidate is the priority.
 *
 * Re-enable native Arabic RTL later behind EXPO_PUBLIC_ENABLE_NATIVE_RTL=1
 * once expo-updates (or equivalent) can safely reload after a direction flip.
 */
import { I18nManager } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { languageMeta, type SupportedLanguageCode } from "./languages";

const RTL_WANTED_KEY = "@ifcdc/layout_rtl_wanted";
const RTL_APPLIED_KEY = "@ifcdc/layout_rtl_applied";
const RTL_LTR_RECOVERY_KEY = "@ifcdc/rtl_ltr_recovery_v72";

function nativeRtlFeatureEnabled(): boolean {
  const raw =
    (typeof process !== "undefined" && process.env?.EXPO_PUBLIC_ENABLE_NATIVE_RTL) || "";
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isRtlLanguage(code: string | null | undefined): boolean {
  return languageMeta(code).rtl === true;
}

/** Force native layout to LTR immediately (English and all LTR langs). */
export function forceNativeLtr(): void {
  try {
    I18nManager.allowRTL(false);
    I18nManager.forceRTL(false);
  } catch {
    /* ignore */
  }
}

function forceNativeRtl(): void {
  try {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(true);
  } catch {
    /* ignore */
  }
}

/**
 * Apply layout direction for the active language.
 * Build 72: always enforce LTR unless EXPO_PUBLIC_ENABLE_NATIVE_RTL is on.
 */
export async function applyLayoutDirectionForLanguage(
  code: SupportedLanguageCode,
): Promise<{ wantRtl: boolean; reloaded: boolean }> {
  const languageWantsRtl = isRtlLanguage(code);
  const wantRtl = languageWantsRtl && nativeRtlFeatureEnabled();

  if (wantRtl) {
    forceNativeRtl();
  } else {
    // Always clear sticky RTL — this is the global mirrored-UI fix.
    forceNativeLtr();
  }

  try {
    await AsyncStorage.multiSet([
      [RTL_WANTED_KEY, wantRtl ? "1" : "0"],
      [RTL_APPLIED_KEY, wantRtl ? "1" : "0"],
      [RTL_LTR_RECOVERY_KEY, "1"],
    ]);
  } catch {
    /* ignore */
  }

  return { wantRtl, reloaded: false };
}

/** One-shot migration: clear sticky RTL if user is on an LTR language. */
export async function clearStickyRtlIfLtr(languageCode: SupportedLanguageCode): Promise<void> {
  // Even for Arabic (while native RTL feature is off), clear sticky RTL.
  if (isRtlLanguage(languageCode) && nativeRtlFeatureEnabled()) return;
  forceNativeLtr();
  try {
    await AsyncStorage.multiSet([
      [RTL_WANTED_KEY, "0"],
      [RTL_APPLIED_KEY, "0"],
      [RTL_LTR_RECOVERY_KEY, "1"],
    ]);
  } catch {
    /* ignore */
  }
}
