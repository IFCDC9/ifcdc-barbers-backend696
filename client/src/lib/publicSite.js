/**
 * Canonical public web origin for IFCDC Barbers (SPA, invites, legal, share links).
 */
export const CANONICAL_PUBLIC_ORIGIN = "https://ifcdcbarbersapp.com";

/** Emergency fallback only — production uses CANONICAL_PUBLIC_ORIGIN. */
export const RENDER_FRONTEND_ORIGIN = "https://ifcdc-barbers-frontend.onrender.com";

export const PUBLIC_CONTACT_EMAIL = "service@ifcdc.org";
export const PUBLIC_SUPPORT_EMAIL = "support@ifcdcbarbersapp.com";

export const PUBLIC_LEGAL = {
  privacy: "/privacy",
  terms: "/terms",
};

/** App Store listing (ASC app id 6766149605). */
export const APP_STORE_URL = "https://apps.apple.com/app/id6766149605";

/** Google Play listing (same package as mobile app.json). */
export const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.ifcdc.barbers";

export const APP_DOWNLOAD_CTA = {
  label: "Download the App",
  href: APP_STORE_URL,
};

/** Native store link for marketing CTAs (iOS → App Store, Android → Play). */
export function resolveAppDownloadHref(userAgent = "") {
  const ua = String(userAgent || "");
  if (/android/i.test(ua)) return PLAY_STORE_URL;
  return APP_STORE_URL;
}
