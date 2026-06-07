import React from "react";

/**
 * PayPal full-page return — route to app-parity booking wizard for finalize.
 * BookingWizard calls POST /api/app-bookings/finalize (same as TestFlight).
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
    if (path === "/booking" || path.endsWith("/booking")) {
      return;
    }

    doneRef.current = true;
    navigate(`/booking?token=${encodeURIComponent(token)}`, { replace: true });
  }, [navigate]);

  return null;
}
