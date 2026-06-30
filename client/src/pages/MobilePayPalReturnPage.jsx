import React from "react";

const APP_SCHEME = "ifcdc-barbers";

/**
 * PayPal full-page return for native app checkout (LIVE mode requires https).
 * ASWebAuthenticationSession matches this URL; we also deep-link back to the app when opened in Safari.
 */
export default function MobilePayPalReturnPage() {
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const token = sp.get("token");
    if (!token) return;

    const params = new URLSearchParams();
    params.set("token", token);
    const payerId = sp.get("PayerID");
    if (payerId) params.set("PayerID", payerId);

    const schemeUrl = `${APP_SCHEME}://paypal-booking/?${params.toString()}`;
    window.setTimeout(() => {
      window.location.replace(schemeUrl);
    }, 120);
  }, []);

  return (
    <div style={{ padding: "48px 24px", textAlign: "center", color: "#f5f5f5" }}>
      <p style={{ fontSize: 18, marginBottom: 12 }}>Payment complete</p>
      <p style={{ opacity: 0.85 }}>Returning to IFCDC Barbers…</p>
    </div>
  );
}
