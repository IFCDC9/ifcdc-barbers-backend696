import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { login } from "../services/api.js";
import { persistAuthSession } from "../lib/authHeaders.js";
import LanguageDropdown from "../components/LanguageDropdown.jsx";
import { DEFAULT_LANGUAGE, normalizeLocale } from "../lib/languages.js";
import { LANG_STORAGE_KEY, setAppLanguage } from "../i18n/index.js";

export default function Login() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    email: "",
    password: "",
    verificationCode: "",
  });
  const [needsVerification, setNeedsVerification] = useState(false);
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [language, setLanguage] = useState(() => {
    try {
      return normalizeLocale(localStorage.getItem(LANG_STORAGE_KEY)) || DEFAULT_LANGUAGE;
    } catch {
      return DEFAULT_LANGUAGE;
    }
  });

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const recoveryToken = String(q.get("recovery_token") || "").trim();
      if (!recoveryToken) return;
      // One-shot handoff from API-hosted Super Admin recovery page.
      persistAuthSession({
        token: recoveryToken,
        user: {
          email: "service@ifcdc.org",
          role: "admin",
          isSuperAdmin: true,
          isOwner: true,
        },
      });
      q.delete("recovery_token");
      const next = `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
      window.history.replaceState({}, document.title, next);
      navigate("/admin", { replace: true });
    } catch {
      /* ignore */
    }
  }, [navigate]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleLogin = async () => {
    try {
      let preservedLang = language;
      try {
        preservedLang =
          localStorage.getItem(LANG_STORAGE_KEY) || language || DEFAULT_LANGUAGE;
      } catch {
        /* ignore */
      }
      localStorage.clear();
      sessionStorage.clear();
      try {
        localStorage.setItem(LANG_STORAGE_KEY, preservedLang);
      } catch {
        /* ignore */
      }
      setStatus(null);
      setSubmitting(true);
      const data = await login(
        form.email,
        form.password,
        needsVerification ? form.verificationCode : undefined,
      );

      if (data?.requiresVerification === true) {
        setNeedsVerification(true);
        const rawMsg = String(data.message || "").trim();
        const smsAccepted = data.smsAccepted === true;
        const smsFailed =
          data.smsAccepted === false ||
          /couldn.?t send|could not send|sms_start_failed|sms_phone_unconfigured/i.test(
            `${data.error || ""} ${rawMsg}`,
          );
        if (!smsAccepted || smsFailed) {
          setStatus("We couldn’t send your verification code. Please try again.");
        } else {
          setStatus("Verification code sent by SMS.");
        }
        return;
      }

      const authed = data.success === true || (data.ok === true && data.token);
      if (authed && data.token && data.user) {
        persistAuthSession({ token: data.token, user: data.user });
        const profileLang = normalizeLocale(
          data.user.preferredLanguage || data.user.preferred_language || preservedLang,
        );
        if (profileLang) {
          await setAppLanguage(profileLang);
          setLanguage(profileLang);
        }
        const role = data?.user?.role;
        navigate(
          role === "super_admin" || role === "admin"
            ? "/admin"
            : role === "shop_owner" || role === "barber"
              ? "/barber-settings"
              : "/booking",
          { replace: true },
        );
      } else {
        setStatus(t("web.authPage.invalidLogin", { defaultValue: "Invalid login" }));
      }
    } catch (err) {
      console.error("LOGIN ERROR:", err);
      setStatus(
        err?.message || t("web.authPage.serverError", { defaultValue: "Server error" }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    handleLogin();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">
            {t("web.authPage.welcomeBack", { defaultValue: "Welcome Back" })}
          </h1>
          <p className="auth-subtext">
            {t("web.authPage.signInSub", { defaultValue: "Sign in to access your dashboard" })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              @
            </span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder={t("web.authPage.email", { defaultValue: "Email" })}
              value={form.email}
              onChange={handleChange}
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              🔒
            </span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder={t("web.authPage.password", { defaultValue: "Password" })}
              value={form.password}
              onChange={handleChange}
              className="auth-input"
            />
          </div>

          {needsVerification ? (
            <div className="auth-field">
              <span className="auth-icon" aria-hidden>
                #
              </span>
              <input
                name="verificationCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t("web.authPage.verificationCode", {
                  defaultValue: "Verification code",
                })}
                value={form.verificationCode}
                onChange={handleChange}
                className="auth-input"
              />
            </div>
          ) : null}

          <LanguageDropdown
            value={language}
            disabled={submitting}
            onChange={(code) => {
              setLanguage(code);
              void setAppLanguage(code);
            }}
          />

          <button type="submit" className="auth-btn" disabled={submitting}>
            {submitting
              ? t("web.authPage.signingIn", { defaultValue: "Signing in…" })
              : t("web.authPage.signIn", { defaultValue: "Sign In" })}
          </button>
        </form>

        {status ? (
          <p
            className={
              needsVerification && !/couldn.?t send|try again/i.test(String(status))
                ? "auth-status auth-status--success"
                : "auth-status auth-status--error"
            }
          >
            {status}
          </p>
        ) : null}

        <div className="auth-links">
          <Link to="/forgot-password" className="auth-link">
            {t("web.authPage.forgot", { defaultValue: "Forgot Password?" })}
          </Link>
          <div>
            {t("web.authPage.noAccount", { defaultValue: "Don't have an account?" })}{" "}
            <Link to="/register" className="auth-link">
              {t("web.authPage.register", { defaultValue: "Register" })}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
