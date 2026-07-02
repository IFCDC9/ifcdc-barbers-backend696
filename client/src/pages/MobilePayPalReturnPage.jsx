import React from "react";
import { useNavigate } from "react-router-dom";

const APP_SCHEME = "ifcdc-barbers";

/**
 * PayPal full-page return for native app checkout (LIVE mode requires https).
 * ASWebAuthenticationSession matches this URL; we deep-link back to the app when installed.
 * Safari / desktop without the app installed fall through to /booking for finalize.
 */
export default function MobilePayPalReturnPage() {
  const navigate = useNavigate();

  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get("token");
    if (!token) return;

    const params = new URLSearchParams();
    params.set("token", token);
    const payerId = sp.get("PayerID");
    if (payerId) params.set("PayerID", payerId);

    const webFinalize = `/booking?${params.toString()}`;
    const schemeUrl = `${APP_SCHEME}://paypal-booking/?${params.toString()}`;

    let fellBack = false;
    const fallbackTimer = window.setTimeout(() => {
      fellBack = true;
      navigate(webFinalize, { replace: true });
    }, 900);

    window.location.href = schemeUrl;

    window.setTimeout(() => {
      if (!fellBack && document.visibilityState === "visible") {
        window.clearTimeout(fallbackTimer);
        navigate(webFinalize, { replace: true });
      }
    }, 1200);
  }, [navigate]);

  return (
    <div style={{ padding: "48px 24px", textAlign: "center", color: "#f5f5f5" }}>
      <p style={{ fontSize: 18, marginBottom: 12 }}>Payment complete</p>
      <p style={{ opacity: 0.85 }}>Returning to IFCDC Barbers…</p>
    </div>
  );
}
