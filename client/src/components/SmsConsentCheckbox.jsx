import { Link } from "react-router-dom";
import {
  SMS_CONSENT_DISCLOSURE_BEFORE_LINKS,
  SMS_CONSENT_LANGUAGE_VERSION,
} from "../content/smsConsentPublic.js";
import { PUBLIC_LEGAL } from "../lib/publicSite.js";

/**
 * Optional SMS consent checkbox — unchecked by default; never required for signup/booking.
 */
export default function SmsConsentCheckbox({
  checked = false,
  onChange,
  id = "sms-consent-opt-in",
  disabled = false,
  className = "",
}) {
  return (
    <label className={`sms-consent-checkbox ${className}`.trim()} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        aria-describedby={`${id}-help`}
      />
      <span className="sms-consent-checkbox__text">
        {SMS_CONSENT_DISCLOSURE_BEFORE_LINKS}
        <Link to={PUBLIC_LEGAL.terms} target="_blank" rel="noopener noreferrer">
          Terms and Conditions
        </Link>
        {" and "}
        <Link to={PUBLIC_LEGAL.privacy} target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </Link>
        .
      </span>
      <span id={`${id}-help`} className="sms-consent-checkbox__hint">
        Optional. Consent is not required to register, book, or pay. Language version{" "}
        {SMS_CONSENT_LANGUAGE_VERSION}.
      </span>
    </label>
  );
}
