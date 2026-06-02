/**
 * Public PayPal client id — single source for PayPalScriptProvider.
 * Prefer VITE_PAYPAL_CLIENT_ID (must match server PAYPAL_CLIENT_ID at build time on Render).
 * Local dev only: fallback below when env is unset (set VITE_* for production builds).
 */
export const PAYPAL_CLIENT_ID = String(import.meta.env.VITE_PAYPAL_CLIENT_ID || "").trim();
