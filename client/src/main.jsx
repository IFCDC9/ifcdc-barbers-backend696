import ReactDOM from "react-dom/client";
import { PayPalScriptProvider } from "@paypal/react-paypal-js";
import App from "./App.jsx";
import ScreenErrorBoundary from "./components/ScreenErrorBoundary.jsx";
import { PAYPAL_CLIENT_ID } from "./config/paypalClientId.js";
import "./styles/global.css";

/**
 * Live Client ID from `client/.env` → `VITE_PAYPAL_CLIENT_ID` (must match root PAYPAL_CLIENT_ID).
 * https://developer.paypal.com/dashboard/applications
 */
const PAYPAL_ID = PAYPAL_CLIENT_ID;
if (!PAYPAL_ID) {
  console.error(
    "[PayPal] Set VITE_PAYPAL_CLIENT_ID on Render (Static Site env) to the same Live Client ID as backend PAYPAL_CLIENT_ID, then redeploy.",
  );
}
/**
 * Default production for release builds; set VITE_PAYPAL_ENVIRONMENT=sandbox only for sandbox Client IDs.
 */
const PAYPAL_ENV =
  import.meta.env.VITE_PAYPAL_ENVIRONMENT === "sandbox" ? "sandbox" : "production";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root — check index.html");
}

const paypalDebug =
  String(import.meta.env.VITE_PAYPAL_DEBUG ?? "").trim() === "true";

/** StrictMode disabled: React 18 double-mount can break PayPal SDK in dev. */
ReactDOM.createRoot(rootEl).render(
  <PayPalScriptProvider
    options={{
      "client-id": PAYPAL_ID,
      currency: "USD",
      ...(paypalDebug ? { debug: true } : {}),
      components: "buttons",
      intent: "capture",
      environment: PAYPAL_ENV,
    }}
  >
    <ScreenErrorBoundary>
      <App />
    </ScreenErrorBoundary>
  </PayPalScriptProvider>
);
