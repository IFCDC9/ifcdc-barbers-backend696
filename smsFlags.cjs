/**
 * SMS feature flags — all default OFF so production is unchanged until explicitly enabled.
 * Existing voiceBookingSms.js paths remain intact regardless of these flags.
 */
function envOn(name, defaultOn = false) {
  const raw = String(process.env[name] ?? (defaultOn ? "1" : "0"))
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return defaultOn;
}

function smsFlags() {
  return {
    /** Booking / payment / reminder / cancel SMS via Messaging Service */
    notificationsEnabled: envOn("SMS_NOTIFICATIONS_ENABLED", false),
    /** Twilio Verify for AURA Super Admin + customer phone verification */
    verifyEnabled: envOn("SMS_VERIFY_ENABLED", false),
    /** Require verified phone before first paid booking (when verify enabled) */
    requireCustomerPhoneVerified: envOn("SMS_CUSTOMER_PHONE_VERIFY_REQUIRED", false),
    /** Inbound STOP/HELP webhook processing */
    inboundConsentEnabled: envOn("SMS_INBOUND_CONSENT_ENABLED", true),
    /** Persist delivery rows even when send is skipped (dry observability) */
    logSkipped: envOn("SMS_LOG_SKIPPED", true),
  };
}

function isSmsNotificationsEnabled() {
  return smsFlags().notificationsEnabled;
}

function isSmsVerifyEnabled() {
  return smsFlags().verifyEnabled;
}

module.exports = {
  smsFlags,
  isSmsNotificationsEnabled,
  isSmsVerifyEnabled,
};
