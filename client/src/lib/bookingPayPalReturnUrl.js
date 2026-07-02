/** Canonical SPA origin for PayPal return/cancel URLs (LIVE requires https). */
export const CANONICAL_BOOKING_WEB_ORIGIN = "https://ifcdcbarbersapp.com";

export function bookingPayPalReturnUrl() {
  return `${CANONICAL_BOOKING_WEB_ORIGIN}/booking`;
}

export function bookingPayPalCancelUrl() {
  return `${CANONICAL_BOOKING_WEB_ORIGIN}/booking?paypal_cancel=1`;
}
