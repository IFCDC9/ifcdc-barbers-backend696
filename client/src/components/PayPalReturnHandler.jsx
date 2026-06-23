import React from "react";
import { isNonPayPalTokenPath, looksLikePasswordResetToken } from "../lib/queryTokenRoutes.js";

/**
 * PayPal full-page return — route to app-parity booking wizard for finalize.
 * BookingWizard calls POST /api/app-bookings/finalize (same as the mobile app).
 *
 * Must NOT steal ?token= on /reset-password, /invite, etc. (password reset uses 64-char hex).
 */
export default function PayPalReturnHandler({ navigate }) {
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    if (doneRef.current) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("paypal_cancel")) {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      return;
    }
    const token = sp.get("token");
    if (!token) return;

    const path = window.location.pathname || "";
    if (isNonPayPalTokenPath(path) || looksLikePasswordResetToken(token)) {
      return;
    }
    if (path === "/booking" || path.endsWith("/booking")) {
      return;
    }

    doneRef.current = true;
    navigate(`/booking?token=${encodeURIComponent(token)}`, { replace: true });
  }, [navigate]);

  return null;
}
