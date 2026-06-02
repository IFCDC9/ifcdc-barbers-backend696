/**
 * LEGACY hash-router shell (Navbar + inline theme styles).
 * Production entry: main.jsx → App.jsx (BrowserRouter, Render visual baseline).
 * Keep payment/booking logic in pages/* — do not swap MainRoutes back as the root app.
 */
import React from "react";
import Navbar from "./components/Navbar.jsx";
import Home from "./pages/Home.jsx";
import Barbers from "./pages/Barbers.jsx";
import Booking from "./pages/Booking.jsx";
import BarberGallery from "./pages/BarberGallery.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import About from "./pages/About.jsx";
import Checkout from "./pages/Checkout.jsx";
import PaymentPage from "./pages/PaymentPage.jsx";
import Confirmation from "./pages/Confirmation.jsx";
import Invite from "./pages/Invite.jsx";
import { theme } from "./components/ui/theme.js";
import { ADMIN_KEY_STORAGE } from "./config/adminClient.js";
import PayPalReturnHandler from "./components/PayPalReturnHandler.jsx";
import { parseRouteFromPath, safeGetRouteFromHash } from "./routing/hashRouter.js";
import { LOGGED_IN_KEY, USER_PUBLIC_KEY, isAdminSession } from "./lib/authSession.js";

export default function MainRoutes() {
  const [route, setRoute] = React.useState(safeGetRouteFromHash);
  const [isLoggedIn, setIsLoggedIn] = React.useState(() => isAdminSession());

  React.useEffect(() => {
    const onHashChange = () => setRoute(safeGetRouteFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  React.useEffect(() => {
    setIsLoggedIn(isAdminSession());
  }, [route]);

  const navigate = React.useCallback((to) => {
    let raw = String(to || "/").trim();
    if (raw.startsWith("#")) raw = raw.slice(1);
    let normalized = raw.trim() || "/";
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    const hash = `#${normalized}`;
    window.location.hash = hash;
    setRoute(parseRouteFromPath(normalized));
  }, []);

  React.useEffect(() => {
    if (route.name !== "dashboard") return;
    if (!isAdminSession()) navigate("/login");
  }, [route.name, navigate]);

  React.useEffect(() => {
    if (route.name !== "login") return;
    if (isAdminSession()) navigate("/dashboard");
  }, [route.name, navigate]);

  return (
    <div style={styles.app}>
      <PayPalReturnHandler navigate={navigate} />
      <Navbar
        route={route}
        navigate={navigate}
        isLoggedIn={isLoggedIn}
        onLogout={() => {
          try {
            window.localStorage.removeItem(LOGGED_IN_KEY);
            window.localStorage.removeItem(ADMIN_KEY_STORAGE);
            window.localStorage.removeItem(USER_PUBLIC_KEY);
          } catch {
            // ignore
          }
          setIsLoggedIn(false);
          navigate("/");
        }}
      />
      <main style={styles.main}>
        {route.name === "barbers" ? (
          <Barbers navigate={navigate} />
        ) : route.name === "barber" ? (
          <BarberGallery barberName={route.params?.barberName || ""} navigate={navigate} />
        ) : route.name === "booking" ? (
          <Booking
            navigate={navigate}
            barberName={route.params?.barberName || ""}
            serviceName={route.params?.serviceName || ""}
            servicePrice={route.params?.servicePrice ?? 20}
            durationMinutes={route.params?.durationMinutes ?? null}
          />
        ) : route.name === "checkout" ? (
          <Checkout
            navigate={navigate}
            barberName={route.params?.barberName || ""}
            serviceName={route.params?.serviceName || ""}
            servicePrice={route.params?.servicePrice ?? 20}
            durationMinutes={route.params?.durationMinutes ?? null}
            date={route.params?.date || ""}
            time={route.params?.time || ""}
          />
        ) : route.name === "payment" ? (
          <PaymentPage
            navigate={navigate}
            barberName={route.params?.barberName || ""}
            serviceName={route.params?.serviceName || ""}
            servicePrice={route.params?.servicePrice ?? 20}
            durationMinutes={route.params?.durationMinutes ?? null}
            date={route.params?.date || ""}
            time={route.params?.time || ""}
          />
        ) : route.name === "confirmation" ? (
          <Confirmation
            navigate={navigate}
            barberName={route.params?.barberName || ""}
            date={route.params?.date || ""}
            time={route.params?.time || ""}
            orderId={route.params?.orderId || ""}
          />
        ) : route.name === "login" ? (
          <Login />
        ) : route.name === "dashboard" ? (
          <Dashboard navigate={navigate} />
        ) : route.name === "invite" ? (
          <Invite token={route.params?.token || ""} navigate={navigate} />
        ) : route.name === "about" ? (
          <About />
        ) : (
          <Home navigate={navigate} />
        )}
      </main>
      <footer style={styles.footer}>
        <span style={styles.footerText}>© 2026 IFCDC • All Rights Reserved</span>
        <span style={styles.footerSub}>Powered by IFCDC Productions</span>
      </footer>
    </div>
  );
}

const styles = {
  app: {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${theme.colors.primary} 0%, #07070B 100%)`,
    color: theme.colors.text,
  },
  main: {
    maxWidth: 1040,
    margin: "0 auto",
    padding: "48px 16px",
  },
  footer: {
    borderTop: `1px solid ${theme.colors.border}`,
    padding: "18px 16px",
  },
  footerText: {
    display: "block",
    maxWidth: 1040,
    margin: "0 auto",
    color: theme.colors.muted,
    fontSize: 12,
    textAlign: "center",
  },
  footerSub: {
    display: "block",
    maxWidth: 1040,
    margin: "6px auto 0",
    color: theme.colors.muted,
    fontSize: 11,
    textAlign: "center",
    opacity: 0.85,
  },
};
