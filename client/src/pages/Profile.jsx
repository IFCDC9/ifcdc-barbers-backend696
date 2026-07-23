import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authenticatedJson } from "../lib/authenticatedFetch.js";
import LanguageDropdown from "../components/LanguageDropdown.jsx";
import { DEFAULT_LANGUAGE, normalizeLocale } from "../lib/languages.js";
import { currentAppLanguage, setAppLanguage } from "../i18n/index.js";
import { persistAuthSession, getStoredToken } from "../lib/authHeaders.js";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

export default function Profile() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [user, setUser] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState(() => currentAppLanguage() || DEFAULT_LANGUAGE);
  const [langSaving, setLangSaving] = useState(false);

  useEffect(() => {
    const u = readUser();
    setUser(u);
    if (u) {
      const fromProfile = normalizeLocale(u.preferredLanguage || u.preferred_language);
      if (fromProfile) {
        setLanguage(fromProfile);
        void setAppLanguage(fromProfile);
      }
    }
    if (!u) return;

    let token = "";
    try {
      token = localStorage.getItem("token") || "";
    } catch {
      /* ignore */
    }
    if (!token) return;

    setLoading(true);
    authenticatedJson("/api/auth/my-bookings")
      .then((data) => {
        const list = Array.isArray(data?.bookings) ? data.bookings : Array.isArray(data) ? data : [];
        setBookings(list);
      })
      .catch((e) => setError(e?.message || "Could not load bookings"))
      .finally(() => setLoading(false));
  }, []);

  const syncPreferredLanguage = async (code) => {
    setLanguage(code);
    await setAppLanguage(code);
    if (!user) return;
    setLangSaving(true);
    try {
      const data = await authenticatedJson("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredLanguage: code, language: code }),
      });
      const nextUser = data?.user || { ...user, preferredLanguage: code };
      const token = getStoredToken();
      if (token) persistAuthSession({ token, user: nextUser });
      setUser(nextUser);
    } catch (e) {
      console.warn("[profile] preferred language sync failed:", e?.message || e);
    } finally {
      setLangSaving(false);
    }
  };

  const logout = () => {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {
      /* ignore */
    }
    navigate("/", { replace: true });
  };

  if (!user) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">
          {t("web.profilePage.title", { defaultValue: "Profile" })}
        </h1>
        <p className="ifcdc-page-lead">Sign in to view your bookings and account.</p>
        <div style={{ maxWidth: 360, marginBottom: 16 }}>
          <LanguageDropdown value={language} onChange={(code) => void syncPreferredLanguage(code)} />
        </div>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          {t("web.nav.signIn", { defaultValue: "Sign in" })}
        </Link>
        <Link to="/register" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          {t("web.authPage.createAccount", { defaultValue: "Create account" })}
        </Link>
      </div>
    );
  }

  const role = String(user.role || "user");
  const canShop = role === "barber" || role === "shop_owner" || role === "admin" || role === "super_admin";
  const canPlatformAdmin = role === "admin" || role === "super_admin";

  return (
    <div className="ifcdc-profile">
      <h1 className="ifcdc-page-title">
        {t("web.profilePage.title", { defaultValue: "Profile" })}
      </h1>
      <div className="ifcdc-book-wizard__summary">
        <p>
          <strong>Name:</strong> {user.name || "—"}
        </p>
        <p>
          <strong>Email:</strong> {user.email || "—"}
        </p>
        <p>
          <strong>Account:</strong>{" "}
          {role === "shop_owner" ? "Shop Admin" : role === "user" ? "Customer" : role}
        </p>
      </div>

      <section className="ifcdc-profile-account" aria-label={t("web.profilePage.language", { defaultValue: "Language" })}>
        <h2 className="ifcdc-book-wizard__heading">
          {t("web.profilePage.language", { defaultValue: "Language" })}
        </h2>
        <LanguageDropdown
          value={language}
          disabled={langSaving}
          onChange={(code) => void syncPreferredLanguage(code)}
        />
      </section>

      {canShop ? (
        <>
          <Link to="/barber-settings" className="ifcdc-book-wizard__cta">
            Shop settings
          </Link>
          {role === "barber" ? (
            <Link to="/profile/schedule" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
              My schedule
            </Link>
          ) : null}
        </>
      ) : null}

      <section className="ifcdc-profile-account" aria-label="Rewards and reviews">
        <h2 className="ifcdc-book-wizard__heading">Rewards &amp; reviews</h2>
        <Link to="/profile/rate-me" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          {t("web.profilePage.rateMe", { defaultValue: "Rate Me" })}
        </Link>
        <Link to="/profile/rewards" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          {t("web.profilePage.rewards", { defaultValue: "Rewards" })}
        </Link>
      </section>
      {canPlatformAdmin ? (
        <Link to="/admin" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          Platform admin
        </Link>
      ) : null}

      <section className="ifcdc-profile-account" aria-label="Account actions">
        <h2 className="ifcdc-book-wizard__heading">Account</h2>
        <button type="button" className="ifcdc-book-wizard__back" onClick={logout}>
          {t("web.profilePage.signOut", { defaultValue: "Sign out" })}
        </button>
        <Link to="/profile/delete-account" className="ifcdc-delete-account__nav-btn">
          {t("web.profilePage.deleteAccount", { defaultValue: "Delete account" })}
        </Link>
        <p className="ifcdc-page-hint ifcdc-delete-account__hint">
          Removes your sign-in, profile, and barber shop data where applicable.
        </p>
      </section>

      <h2 className="ifcdc-book-wizard__heading">
        {t("web.profilePage.myBookings", { defaultValue: "My bookings" })}
      </h2>
      {loading ? (
        <p className="ifcdc-page-hint">{t("web.profilePage.loading", { defaultValue: "Loading…" })}</p>
      ) : null}
      {error ? <p className="ifcdc-error-msg">{error}</p> : null}
      {!loading && !bookings.length && !error ? (
        <p className="ifcdc-page-hint">
          {t("web.profilePage.emptyBookings", { defaultValue: "You don't have any bookings yet." })}{" "}
          <Link to="/booking">{t("web.homePage.bookNow", { defaultValue: "Book now" })}</Link>
        </p>
      ) : null}
      <ul className="ifcdc-book-wizard__list">
        {bookings.map((b) => {
          const completed = String(b.booking_status || b.status || "").toLowerCase() === "completed";
          return (
            <li key={b.id} className="ifcdc-book-wizard__summary">
              <strong>{b.service || b.service_name || "Appointment"}</strong>
              <br />
              {b.barber_name || b.barberName || "Barber"} · {b.date || b.appointment_date} {b.time || b.appointment_time}
              <br />
              Status: {b.booking_status || b.status || "—"}
              {completed ? (
                <>
                  <br />
                  <Link to={`/profile/bookings/${b.id}/review`} className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" style={{ display: "inline-block", marginTop: 8 }}>
                    {t("web.reviewsPage.title", { defaultValue: "Leave a review" })}
                  </Link>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
