import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { validatePasswordStrength } from "../lib/passwordPolicy.js";
import { validateSignupPhone } from "../lib/phoneValidation.js";
import { register } from "../services/api.js";
import LanguageDropdown from "../components/LanguageDropdown.jsx";
import ProviderTypeDropdown from "../components/ProviderTypeDropdown.jsx";
import SmsConsentCheckbox from "../components/SmsConsentCheckbox.jsx";
import { SMS_CONSENT_LANGUAGE_VERSION } from "../content/smsConsentPublic.js";
import { DEFAULT_LANGUAGE, normalizeLocale } from "../lib/languages.js";
import { LANG_STORAGE_KEY, setAppLanguage, currentAppLanguage } from "../i18n/index.js";

export default function Register() {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    accountSelection: "customer",
    shopName: "",
    address: "",
    city: "",
    state: "",
  });
  const [language, setLanguage] = useState(() => {
    try {
      return normalizeLocale(localStorage.getItem(LANG_STORAGE_KEY)) || currentAppLanguage() || DEFAULT_LANGUAGE;
    } catch {
      return DEFAULT_LANGUAGE;
    }
  });
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [smsConsentOptIn, setSmsConsentOptIn] = useState(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const isCustomer = form.accountSelection === "customer";
  const isShopOwner = form.accountSelection === "shop_owner";
  const showShopFields = !isCustomer;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);
    setTone(null);
    const pwCheck = validatePasswordStrength(form.password);
    if (!pwCheck.valid) {
      setStatus(pwCheck.message);
      setTone("error");
      return;
    }
    const phoneCheck = validateSignupPhone(form.phone);
    if (!phoneCheck.ok) {
      setStatus(phoneCheck.message);
      setTone("error");
      return;
    }
    if (!acceptedTerms || !acceptedPrivacy) {
      setStatus("Please accept the Terms and Privacy Policy.");
      setTone("error");
      return;
    }
    setSubmitting(true);
    try {
      const accountType = isCustomer ? "customer" : isShopOwner ? "shop_owner" : "barber";
      const role = isCustomer ? "user" : isShopOwner ? "shop_owner" : "barber";
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        accountType,
        role,
        providerType: !isCustomer ? form.accountSelection : undefined,
        language,
        preferredLanguage: language,
        phone: phoneCheck.display,
        shopName: form.shopName.trim(),
        businessName: form.shopName.trim(),
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        smsConsentOptIn: Boolean(smsConsentOptIn),
        consentLanguageVersion: SMS_CONSENT_LANGUAGE_VERSION,
        acceptances: [
          { documentKey: "terms", accepted: true },
          { documentKey: "privacy", accepted: true },
          {
            documentKey: "sms_consent",
            accepted: Boolean(smsConsentOptIn),
            version: SMS_CONSENT_LANGUAGE_VERSION,
          },
        ],
      });
      await setAppLanguage(language);
      setStatus("Account created! You can sign in.");
      setTone("success");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Error registering");
      setTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">
            {t("web.authPage.createAccount", { defaultValue: "Create account" })}
          </h1>
          <p className="auth-subtext">
            {t("web.authPage.joinCommunity", { defaultValue: "Join the IFCDC community." })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <LanguageDropdown
            hint={t("web.authPage.languageHint", { defaultValue: "You can change this later in Profile." })}
            value={language}
            disabled={submitting}
            onChange={(code) => {
              setLanguage(code);
              void setAppLanguage(code);
            }}
          />

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              👤
            </span>
            <input
              name="name"
              type="text"
              autoComplete="name"
              placeholder={t("web.authPage.firstName", { defaultValue: "Name" })}
              value={form.name}
              onChange={handleChange}
              className="auth-input"
              required
            />
          </div>

          <div className="auth-field" style={{ display: "grid", gap: 8 }}>
            <ProviderTypeDropdown
              label="Account type"
              includeCustomer
              value={form.accountSelection}
              disabled={submitting}
              onChange={(value) => setForm({ ...form, accountSelection: value })}
            />
            <p className="auth-subtext" style={{ margin: 0, fontSize: "0.8rem", opacity: 0.75 }}>
              Service providers can book clients once approved. Shop owners manage their own shop.
            </p>
          </div>

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              📞
            </span>
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder={t("web.authPage.phone", { defaultValue: "Phone" })}
              value={form.phone}
              onChange={handleChange}
              className="auth-input"
              required
            />
          </div>

          {showShopFields ? (
            <>
              <div className="auth-field">
                <span className="auth-icon" aria-hidden>
                  🏪
                </span>
                <input
                  name="shopName"
                  type="text"
                  placeholder="Shop name"
                  value={form.shopName}
                  onChange={handleChange}
                  className="auth-input"
                  required
                />
              </div>
              <div className="auth-field">
                <span className="auth-icon" aria-hidden>
                  📍
                </span>
                <input
                  name="address"
                  type="text"
                  placeholder={isShopOwner ? "Shop address" : "Location / address"}
                  value={form.address}
                  onChange={handleChange}
                  className="auth-input"
                  required={isShopOwner}
                />
              </div>
              <div className="auth-field">
                <span className="auth-icon" aria-hidden>
                  🌆
                </span>
                <input
                  name="city"
                  type="text"
                  placeholder="City"
                  value={form.city}
                  onChange={handleChange}
                  className="auth-input"
                  required={isShopOwner}
                />
              </div>
              <div className="auth-field">
                <span className="auth-icon" aria-hidden>
                  🗺
                </span>
                <input
                  name="state"
                  type="text"
                  placeholder="State"
                  value={form.state}
                  onChange={handleChange}
                  className="auth-input"
                  required={isShopOwner}
                />
              </div>
            </>
          ) : null}

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
              required
            />
          </div>

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              🔒
            </span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={t("web.authPage.password", { defaultValue: "Password" })}
              value={form.password}
              onChange={handleChange}
              className="auth-input"
              required
            />
          </div>
          <p className="auth-subtext" style={{ margin: "-4px 0 8px", fontSize: "0.85rem", opacity: 0.85 }}>
            Min 12 characters: uppercase, lowercase, number, and symbol. Common passwords are rejected.
          </p>

          <label className="auth-subtext" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
            <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} />
            <span>
              I agree to the{" "}
              <Link to="/terms">{t("web.footer.terms", { defaultValue: "Terms and Conditions" })}</Link>
            </span>
          </label>
          <label className="auth-subtext" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
            <input type="checkbox" checked={acceptedPrivacy} onChange={(e) => setAcceptedPrivacy(e.target.checked)} />
            <span>
              I agree to the{" "}
              <Link to="/privacy">{t("web.footer.privacy", { defaultValue: "Privacy Policy" })}</Link>
            </span>
          </label>

          <SmsConsentCheckbox
            id="register-sms-consent"
            checked={smsConsentOptIn}
            onChange={setSmsConsentOptIn}
            disabled={submitting}
          />

          <button type="submit" disabled={submitting} className="auth-btn">
            {submitting
              ? t("web.common.loading", { defaultValue: "Loading…" })
              : t("web.authPage.createAccountBtn", { defaultValue: "Create account" })}
          </button>
        </form>

        {status ? (
          <p className={`auth-status ${tone === "success" ? "auth-status--success" : "auth-status--error"}`}>{status}</p>
        ) : null}

        <div className="auth-links">
          <div>
            {t("web.authPage.haveAccount", { defaultValue: "Already have an account?" })}{" "}
            <Link to="/login" className="auth-link">
              {t("web.authPage.signInLink", { defaultValue: "Sign in" })}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
