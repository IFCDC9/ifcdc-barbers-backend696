import { APP_LANDING_URL } from "./shareContent";

/** PayPal LIVE requires https return/cancel URLs (custom schemes are rejected). */
export function resolveMobilePayPalReturnUrl(): string {
  const base = String(APP_LANDING_URL || "https://ifcdcbarbersapp.com").replace(/\/+$/, "");
  return `${base}/paypal-booking`;
}
