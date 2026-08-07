import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import PayPalReturnBridge from "./components/PayPalReturnBridge.jsx";
import MainLayout from "./layouts/MainLayout.jsx";
import { IFCDC_GOLD } from "./lib/ifcdcColors.js";
import {
  ConfirmationRoute,
} from "./routes/paymentFlowRoutes.jsx";
import Home from "./pages/Home.jsx";
import BookingWizard from "./pages/BookingWizard.jsx";
import AuraPage from "./pages/AuraPage.jsx";
import Profile from "./pages/Profile.jsx";
import DeleteAccount from "./pages/DeleteAccount.jsx";
import About from "./pages/About.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import Admin from "./pages/Admin.jsx";
import AdminManualBooking from "./pages/AdminManualBooking.jsx";
import AdminGlobalBarbers from "./pages/AdminGlobalBarbers.jsx";
import AdminContentModeration from "./pages/AdminContentModeration.jsx";
import AdminLoyaltyRewards from "./pages/AdminLoyaltyRewards.jsx";
import AdminAuraKnowledge from "./pages/AdminAuraKnowledge.jsx";
import AdminSmsDelivery from "./pages/AdminSmsDelivery.jsx";
import AdminAuraVoice from "./pages/AdminAuraVoice.jsx";
import AdminShops from "./pages/AdminShops.jsx";
import AdminShopDetail from "./pages/AdminShopDetail.jsx";
import BarberSettings from "./pages/BarberSettings.jsx";
import RequireRole from "./components/RequireRole.jsx";
import Invite from "./pages/Invite.jsx";
import PublicLegalPage from "./pages/PublicLegalPage.jsx";
import SmsConsentPage from "./pages/SmsConsentPage.jsx";
import SmsComplianceEvidencePage from "./pages/SmsComplianceEvidencePage.jsx";
import IFCDCGlobalFooter from "./components/IFCDCGlobalFooter.jsx";
import StylesBrowse from "./pages/StylesBrowse.jsx";
import StyleDiscoverPage from "./pages/StyleDiscoverPage.jsx";
import BarberPortfolioPage from "./pages/BarberPortfolioPage.jsx";
import MobilePayPalReturnPage from "./pages/MobilePayPalReturnPage.jsx";
import BookingReviewPage from "./pages/BookingReviewPage.jsx";
import RateMePage from "./pages/RateMePage.jsx";
import RewardsPage from "./pages/RewardsPage.jsx";
import ProviderSchedulePage from "./pages/ProviderSchedulePage.jsx";
import SignupBusiness from "./pages/SignupBusiness.jsx";
import BarberOnboarding from "./pages/BarberOnboarding.jsx";
import Messages from "./pages/Messages.jsx";
import NotFound from "./pages/NotFound.jsx";
import { useTranslation } from "react-i18next";
import { getPickerLanguages } from "./lib/languages.js";
import { currentAppLanguage, setAppLanguage } from "./i18n/index.js";

/** Legacy booking page — kept for reference; wizard is production path. */
import Booking from "./pages/Booking.jsx";

function HeaderLanguageSelect() {
  const { t, i18n } = useTranslation();
  const options = getPickerLanguages();
  const value = currentAppLanguage() || i18n.language || "en";
  return (
    <label className="app-header__lang">
      <span className="sr-only">{t("web.language.label", { defaultValue: "Language" })}</span>
      <select
        className="app-header__lang-select"
        value={value}
        aria-label={t("web.language.label", { defaultValue: "Language" })}
        onChange={(e) => void setAppLanguage(e.target.value)}
      >
        {options.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

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
        <span className="app-header__brand" aria-hidden>
          IFCDC
        </span>
        <HeaderLanguageSelect />
      </div>

      <div className="app-content">
        <PayPalReturnBridge />
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/barbers" element={<Navigate to="/booking" replace />} />
            <Route path="/styles" element={<StylesBrowse />} />
            <Route path="/discover" element={<StyleDiscoverPage />} />
            <Route path="/p/:slug" element={<BarberPortfolioPage />} />
            <Route path="/barbers/:slug" element={<BarberPortfolioPage />} />
            <Route path="/book" element={<Navigate to="/booking" replace />} />
            <Route path="/booking" element={<BookingWizard />} />
            <Route path="/paypal-booking" element={<MobilePayPalReturnPage />} />
            <Route path="/booking-legacy" element={<Booking />} />
            <Route path="/aura" element={<AuraPage />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/rate-me" element={<RateMePage />} />
            <Route path="/profile/rewards" element={<RewardsPage />} />
            <Route path="/profile/schedule" element={<ProviderSchedulePage />} />
            <Route path="/profile/bookings/:bookingId/review" element={<BookingReviewPage />} />
            <Route path="/profile/delete-account" element={<DeleteAccount />} />
            <Route path="/checkout" element={<Navigate to="/booking" replace />} />
            <Route path="/payment" element={<Navigate to="/booking" replace />} />
            <Route path="/confirmation" element={<ConfirmationRoute />} />
            <Route path="/phone" element={<Navigate to="/aura" replace />} />
            <Route path="/about" element={<About />} />
            <Route path="/login" element={<Login />} />
            <Route path="/invite" element={<Invite />} />
            <Route path="/privacy" element={<PublicLegalPage />} />
            <Route path="/terms" element={<PublicLegalPage />} />
            <Route path="/sms-consent" element={<SmsConsentPage />} />
            <Route path="/sms-consent-evidence" element={<SmsComplianceEvidencePage />} />
            <Route path="/register" element={<Register />} />
            <Route path="/signup-business" element={<SignupBusiness />} />
            <Route path="/onboarding/barber" element={<BarberOnboarding />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/dashboard"
              element={<Navigate to="/barber-settings" replace />}
            />
            <Route
              path="/barber-settings"
              element={
                <RequireRole roles={["barber", "shop_owner", "admin", "super_admin"]}>
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
            <Route
              path="/admin/manual-booking"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminManualBooking />
                </RequireRole>
              }
            />
            <Route
              path="/admin/barbers"
              element={
                <RequireRole roles={["admin", "super_admin", "shop_owner"]}>
                  <AdminGlobalBarbers />
                </RequireRole>
              }
            />
            <Route
              path="/admin/content-moderation"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminContentModeration />
                </RequireRole>
              }
            />
            <Route
              path="/admin/loyalty"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminLoyaltyRewards />
                </RequireRole>
              }
            />
            <Route
              path="/admin/aura-knowledge"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminAuraKnowledge />
                </RequireRole>
              }
            />
            <Route
              path="/admin/sms-delivery"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminSmsDelivery />
                </RequireRole>
              }
            />
            <Route
              path="/admin/aura-voice"
              element={
                <RequireRole roles={["admin", "super_admin"]}>
                  <AdminAuraVoice />
                </RequireRole>
              }
            />
            <Route
              path="/admin/shops"
              element={
                <RequireRole roles={["admin", "super_admin", "shop_owner"]}>
                  <AdminShops />
                </RequireRole>
              }
            />
            <Route
              path="/admin/shops/:shopId"
              element={
                <RequireRole roles={["admin", "super_admin", "shop_owner"]}>
                  <AdminShopDetail />
                </RequireRole>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </div>

      <IFCDCGlobalFooter />
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
