/**
 * A2P SMS consent language — keep in sync with client/src/content/smsConsentPublic.js
 */
const SMS_CONSENT_LANGUAGE_VERSION = "ifcdc-sms-consent-v1-2026-08";

const SMS_SENDER_IDENTITY =
  "IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC)";

const SMS_CONSENT_DISCLOSURE =
  "I agree to receive customer-care and appointment-related text messages from IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC), including booking confirmations, appointment reminders, rescheduling or cancellation notices, payment and account updates, and customer-support replies. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase. View our Terms and Conditions and Privacy Policy.";

const SMS_PRIVACY_NON_SALE_DISCLOSURE =
  "Mobile phone numbers, SMS consent records, and messaging opt-in information are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes.";

module.exports = {
  SMS_CONSENT_LANGUAGE_VERSION,
  SMS_SENDER_IDENTITY,
  SMS_CONSENT_DISCLOSURE,
  SMS_PRIVACY_NON_SALE_DISCLOSURE,
};
