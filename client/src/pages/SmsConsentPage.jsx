import { useState } from "react";
import { Link } from "react-router-dom";
import SmsConsentCheckbox from "../components/SmsConsentCheckbox.jsx";
import {
  SMS_CONSENT_LANGUAGE_VERSION,
  SMS_SENDER_IDENTITY,
} from "../content/smsConsentPublic.js";
import { CANONICAL_PUBLIC_ORIGIN, PUBLIC_CONTACT_EMAIL, PUBLIC_LEGAL } from "../lib/publicSite.js";
import { getApiOrigin } from "../services/api.js";
import { validateSignupPhone } from "../lib/phoneValidation.js";

/**
 * Public A2P SMS consent page — no login, payment, or account required.
 * https://ifcdcbarbersapp.com/sms-consent
 */
export default function SmsConsentPage() {
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);
    setTone(null);

    const phoneCheck = validateSignupPhone(phone);
    if (!phoneCheck.ok) {
      setStatus(phoneCheck.message);
      setTone("error");
      return;
    }
    if (!smsOptIn) {
      setStatus(
        "Check the SMS consent box to opt in, or leave it unchecked — you can still use IFCDC Barbers App without SMS.",
      );
      setTone("error");
      return;
    }

    setSubmitting(true);
    try {
      const origin = getApiOrigin();
      const res = await fetch(`${origin}/api/sms/consent/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          phone: phoneCheck.display,
          optIn: true,
          source: "public_sms_consent_page",
          consentLanguageVersion: SMS_CONSENT_LANGUAGE_VERSION,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `Could not save consent (HTTP ${res.status})`);
      }
      setStatus(
        "Thank you. Your SMS consent has been recorded for customer-care and appointment messages from IFCDC Barbers App. Reply STOP anytime to opt out.",
      );
      setTone("success");
      setSmsOptIn(false);
      setPhone("");
    } catch (err) {
      setStatus(err?.message || "Could not save SMS consent.");
      setTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="public-legal sms-consent-page">
      <p className="ifcdc-hero-brand">IFCDC BARBERS APP</p>
      <p className="sms-consent-page__identity">{SMS_SENDER_IDENTITY}</p>
      <h1 className="public-legal__title">SMS Consent</h1>
      <p className="public-legal__meta">
        Public opt-in for customer-care and appointment text messages · {CANONICAL_PUBLIC_ORIGIN}
      </p>

      <section className="public-legal__section">
        <h2>Messaging program</h2>
        <p>
          Text messages are sent by <strong>{SMS_SENDER_IDENTITY}</strong>. Messages cover booking
          confirmations, appointment reminders, rescheduling or cancellation notices, payment and
          account updates, and customer-support replies. Message frequency varies. Message and data
          rates may apply. Reply <strong>STOP</strong> to opt out or <strong>HELP</strong> for help.
          Consent is not a condition of purchase.
        </p>
      </section>

      <form className="sms-consent-page__form auth-form" onSubmit={onSubmit} noValidate>
        <label className="sms-consent-page__field" htmlFor="sms-consent-phone">
          <span>Mobile phone number</span>
          <input
            id="sms-consent-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(989) 555-0100"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="auth-input"
            required
            disabled={submitting}
          />
        </label>

        <SmsConsentCheckbox
          id="public-sms-consent"
          checked={smsOptIn}
          onChange={setSmsOptIn}
          disabled={submitting}
        />

        <button type="submit" className="auth-btn" disabled={submitting}>
          {submitting ? "Saving…" : "Save SMS consent"}
        </button>
      </form>

      {status ? (
        <p
          className={`auth-status ${tone === "success" ? "auth-status--success" : "auth-status--error"}`}
          role="status"
        >
          {status}
        </p>
      ) : null}

      <p className="public-legal__section" style={{ marginTop: "1.5rem" }}>
        You can register and book without SMS. Prefer email or in-app notifications instead.{" "}
        <Link to="/register">Create an account</Link>
        {" · "}
        <Link to={PUBLIC_LEGAL.terms}>Terms and Conditions</Link>
        {" · "}
        <Link to={PUBLIC_LEGAL.privacy}>Privacy Policy</Link>
        {" · "}
        <Link to="/sms-consent-evidence">Compliance evidence</Link>
      </p>

      <p className="public-legal__contact">
        Contact: <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
      </p>
      <Link to="/" className="public-legal__back">
        ← Back to IFCDC Barbers App
      </Link>
    </article>
  );
}
