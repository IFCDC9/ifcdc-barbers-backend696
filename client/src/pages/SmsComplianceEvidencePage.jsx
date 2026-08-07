import { Link } from "react-router-dom";
import SmsConsentCheckbox from "../components/SmsConsentCheckbox.jsx";
import {
  SMS_CONSENT_DISCLOSURE,
  SMS_CONSENT_LANGUAGE_VERSION,
  SMS_SENDER_IDENTITY,
} from "../content/smsConsentPublic.js";
import { CANONICAL_PUBLIC_ORIGIN, PUBLIC_CONTACT_EMAIL, PUBLIC_LEGAL } from "../lib/publicSite.js";

/**
 * Public Twilio A2P compliance-evidence page.
 * Shows the complete SMS consent UI (including signup checkbox workflow) without authentication.
 */
export default function SmsComplianceEvidencePage() {
  return (
    <article className="public-legal sms-evidence-page">
      <p className="ifcdc-hero-brand">IFCDC BARBERS APP</p>
      <p className="sms-consent-page__identity">{SMS_SENDER_IDENTITY}</p>
      <h1 className="public-legal__title">SMS Consent — Compliance Evidence</h1>
      <p className="public-legal__meta">
        Public evidence for A2P 10DLC campaign review · {CANONICAL_PUBLIC_ORIGIN}
      </p>

      <section className="public-legal__section">
        <h2>Business identity</h2>
        <p>
          Messaging sender: <strong>{SMS_SENDER_IDENTITY}</strong>
        </p>
        <p>
          Public website domain: <strong>ifcdcbarbersapp.com</strong>
        </p>
        <ul>
          <li>
            Live SMS consent:{" "}
            <a href={`${CANONICAL_PUBLIC_ORIGIN}/sms-consent`}>
              {CANONICAL_PUBLIC_ORIGIN}/sms-consent
            </a>
          </li>
          <li>
            Live registration:{" "}
            <a href={`${CANONICAL_PUBLIC_ORIGIN}/register`}>
              {CANONICAL_PUBLIC_ORIGIN}/register
            </a>
          </li>
          <li>
            Terms and Conditions:{" "}
            <a href={`${CANONICAL_PUBLIC_ORIGIN}${PUBLIC_LEGAL.terms}`}>
              {CANONICAL_PUBLIC_ORIGIN}
              {PUBLIC_LEGAL.terms}
            </a>
          </li>
          <li>
            Privacy Policy:{" "}
            <a href={`${CANONICAL_PUBLIC_ORIGIN}${PUBLIC_LEGAL.privacy}`}>
              {CANONICAL_PUBLIC_ORIGIN}
              {PUBLIC_LEGAL.privacy}
            </a>
          </li>
        </ul>
      </section>

      <section className="public-legal__section">
        <h2>Exact consent language (version {SMS_CONSENT_LANGUAGE_VERSION})</h2>
        <blockquote className="sms-evidence-page__quote">{SMS_CONSENT_DISCLOSURE}</blockquote>
      </section>

      <section className="public-legal__section">
        <h2>Screenshot 1 — Public SMS consent page (no login)</h2>
        <p>
          Customers can opt in at <Link to="/sms-consent">/sms-consent</Link> without creating an
          account, paying, or signing in. The SMS checkbox is unchecked by default and is not
          required to use the application.
        </p>
        <div className="sms-evidence-frame" role="img" aria-label="Screenshot of public SMS consent form">
          <div className="sms-evidence-frame__chrome">
            <span>{CANONICAL_PUBLIC_ORIGIN}/sms-consent</span>
          </div>
          <div className="sms-evidence-frame__body">
            <p className="ifcdc-hero-brand">IFCDC BARBERS APP</p>
            <p className="sms-consent-page__identity">{SMS_SENDER_IDENTITY}</p>
            <h3>SMS Consent</h3>
            <label className="sms-consent-page__field">
              <span>Mobile phone number</span>
              <input className="auth-input" type="tel" value="(989) 555-0142" readOnly />
            </label>
            <SmsConsentCheckbox id="evidence-public-sms" checked={false} onChange={() => {}} disabled />
            <button type="button" className="auth-btn" disabled>
              Save SMS consent
            </button>
          </div>
        </div>
      </section>

      <section className="public-legal__section">
        <h2>Screenshot 2 — Account registration SMS checkbox (optional)</h2>
        <p>
          On <Link to="/register">/register</Link>, Terms and Privacy acceptance remain separate from
          SMS consent. The SMS checkbox below is optional, unchecked by default, and is never required
          to register, book, or pay. Customers who skip SMS still receive email and in-app
          notifications.
        </p>
        <div className="sms-evidence-frame" role="img" aria-label="Screenshot of registration SMS consent checkbox">
          <div className="sms-evidence-frame__chrome">
            <span>{CANONICAL_PUBLIC_ORIGIN}/register</span>
          </div>
          <div className="sms-evidence-frame__body">
            <p className="ifcdc-hero-brand">IFCDC BARBERS APP</p>
            <h3>Create account</h3>
            <input className="auth-input" readOnly value="Jordan Customer" />
            <input className="auth-input" readOnly value="(989) 555-0142" style={{ marginTop: 8 }} />
            <input className="auth-input" readOnly value="jordan@example.com" style={{ marginTop: 8 }} />
            <label className="sms-consent-checkbox" style={{ marginTop: 12 }}>
              <input type="checkbox" checked readOnly disabled />
              <span>I agree to the Terms and Conditions (required, separate from SMS)</span>
            </label>
            <label className="sms-consent-checkbox">
              <input type="checkbox" checked readOnly disabled />
              <span>I agree to the Privacy Policy (required, separate from SMS)</span>
            </label>
            <SmsConsentCheckbox id="evidence-register-sms" checked={false} onChange={() => {}} disabled />
            <p className="sms-consent-checkbox__hint">
              SMS opt-in shown unchecked — registration can complete without selecting it.
            </p>
          </div>
        </div>
      </section>

      <section className="public-legal__section">
        <h2>Compliance records</h2>
        <p>
          When SMS consent is given, IFCDC Barbers App stores the mobile number, consent status,
          timestamp, consent-language version ({SMS_CONSENT_LANGUAGE_VERSION}), and signup source
          separately from general Terms acceptance.
        </p>
      </section>

      <p className="public-legal__contact">
        Contact: <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>
      </p>
      <Link to="/sms-consent" className="public-legal__back">
        ← SMS consent page
      </Link>
    </article>
  );
}
