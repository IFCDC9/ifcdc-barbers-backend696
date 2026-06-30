/**
 * Routes where `?token=` is used for auth/invites — not PayPal order capture.
 * PayPalReturnHandler must not hijack these links.
 */
const NON_PAYPAL_TOKEN_PATHS = new Set([
  "/reset-password",
  "/forgot-password",
  "/invite",
  "/login",
  "/register",
  "/paypal-booking",
]);

export function isNonPayPalTokenPath(pathname) {
  const p = String(pathname || "")
    .replace(/\/$/, "")
    .toLowerCase();
  if (!p || p === "/") return false;
  return NON_PAYPAL_TOKEN_PATHS.has(p) || NON_PAYPAL_TOKEN_PATHS.has(p.split("/").pop() || "");
}

/** Password reset tokens are 32-byte hex from the Node API. */
export function looksLikePasswordResetToken(token) {
  return /^[a-f0-9]{64}$/i.test(String(token || "").trim());
}
