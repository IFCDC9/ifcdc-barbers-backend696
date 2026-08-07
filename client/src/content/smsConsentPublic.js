/**
 * A2P 10DLC SMS consent — shared public disclosure copy (web + API).
 * Keep languageVersion in sync with smsConsentPublic.cjs on the backend.
 */

export const SMS_CONSENT_LANGUAGE_VERSION = "ifcdc-sms-consent-v1-2026-08";

export const SMS_SENDER_IDENTITY =
  "IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC)";

export const SMS_CONSENT_DISCLOSURE =
  "I agree to receive customer-care and appointment-related text messages from IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC), including booking confirmations, appointment reminders, rescheduling or cancellation notices, payment and account updates, and customer-support replies. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase. View our Terms and Conditions and Privacy Policy.";

/** Split so Terms / Privacy can be linked without altering disclosure wording. */
export const SMS_CONSENT_DISCLOSURE_BEFORE_LINKS =
  "I agree to receive customer-care and appointment-related text messages from IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC), including booking confirmations, appointment reminders, rescheduling or cancellation notices, payment and account updates, and customer-support replies. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase. View our ";

export const SMS_PRIVACY_NON_SALE_DISCLOSURE =
  "Mobile phone numbers, SMS consent records, and messaging opt-in information are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes.";
