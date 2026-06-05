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

/** TestFlight — replace when public beta link is available. */
export const TESTFLIGHT_CTA = {
  label: "Get the iOS app (TestFlight)",
  href: "mailto:service@ifcdc.org?subject=IFCDC%20Barbers%20TestFlight%20access",
  hint: "Email service@ifcdc.org for TestFlight access while we expand public beta.",
};
