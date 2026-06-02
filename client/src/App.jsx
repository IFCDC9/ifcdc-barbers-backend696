import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Aura from "./components/Aura.jsx";
import PayPalReturnBridge from "./components/PayPalReturnBridge.jsx";
import MainLayout from "./layouts/MainLayout.jsx";
import { IFCDC_GOLD } from "./lib/ifcdcColors.js";
import {
  CheckoutRoute,
  ConfirmationRoute,
  PaymentRoute,
} from "./routes/paymentFlowRoutes.jsx";
import Home from "./pages/Home.jsx";
import Barbers from "./pages/Barbers.jsx";
import Booking from "./pages/Booking.jsx";
import StylesBrowse from "./pages/StylesBrowse.jsx";
import Phone from "./pages/Phone.jsx";
import About from "./pages/About.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import Admin from "./pages/Admin.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import BarberSettings from "./pages/BarberSettings.jsx";
import RequireRole from "./components/RequireRole.jsx";
import Invite from "./pages/Invite.jsx";
import IFCDCGlobalFooter from "./components/IFCDCGlobalFooter.jsx";

function AppShell() {
  return (
    // DO NOT ADD max-w or mx-auto to root layout
    // This breaks full-screen snap behavior
    <div className="app-container">
      <div
        className="ifcdc-tab-accent-bar"
        style={{
          height: "3px",
          background: IFCDC_GOLD,
          boxShadow: "0 0 6px #FFD700",
          flexShrink: 0,
        }}
        aria-hidden
      />
      <div className="app-header" style={{ color: IFCDC_GOLD, borderBottomColor: "rgba(255, 215, 0, 0.35)" }}>
        IFCDC
      </div>

      <div className="app-content">
        <PayPalReturnBridge />
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/barbers" element={<Barbers />} />
            <Route path="/styles" element={<StylesBrowse />} />
            <Route path="/book" element={<Navigate to="/booking" replace />} />
            <Route path="/booking" element={<Booking />} />
            <Route path="/checkout" element={<CheckoutRoute />} />
            <Route path="/payment" element={<PaymentRoute />} />
            <Route path="/confirmation" element={<ConfirmationRoute />} />
            <Route path="/phone" element={<Phone />} />
            <Route path="/about" element={<About />} />
            <Route path="/login" element={<Login />} />
            <Route path="/invite" element={<Invite />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/dashboard"
              element={
                <RequireRole roles={["barber", "admin", "super_admin"]}>
                  <Dashboard />
                </RequireRole>
              }
            />
            <Route
              path="/barber-settings"
              element={
                <RequireRole roles={["barber", "admin", "super_admin"]}>
                  <BarberSettings />
                </RequireRole>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <Admin />
                </RequireRole>
              }
            />
          </Route>
        </Routes>
      </div>

      <IFCDCGlobalFooter />

      <div className="aura-button">
        <Aura />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
