/**
 * Shared Twilio client helpers for Verify + Messaging Service.
 * Credentials only from env — never hardcoded.
 */
const twilio = require("twilio");

function stripOuterQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function getTwilioAccountSid() {
  return stripOuterQuotes(process.env.TWILIO_ACCOUNT_SID || "").replace(/\s/g, "");
}

function getTwilioAuthToken() {
  return stripOuterQuotes(process.env.TWILIO_AUTH_TOKEN || "").replace(/\s/g, "");
}

function getTwilioVerifyServiceSid() {
  return stripOuterQuotes(process.env.TWILIO_VERIFY_SERVICE_SID || "").replace(/\s/g, "");
}

function getTwilioMessagingServiceSid() {
  return stripOuterQuotes(process.env.TWILIO_MESSAGING_SERVICE_SID || "").replace(/\s/g, "");
}

function getTwilioPhoneNumber() {
  return stripOuterQuotes(
    process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_SMS_FROM || "",
  ).replace(/\s/g, "");
}

function isTwilioAccountConfigured() {
  const sid = getTwilioAccountSid();
  const token = getTwilioAuthToken();
  return Boolean(sid && token && sid.startsWith("AC"));
}

function isTwilioMessagingConfigured() {
  const ms = getTwilioMessagingServiceSid();
  return isTwilioAccountConfigured() && Boolean(ms && /^MG[0-9a-fA-F]{32}$/.test(ms));
}

function isTwilioVerifyConfigured() {
  const vs = getTwilioVerifyServiceSid();
  return isTwilioAccountConfigured() && Boolean(vs && /^VA[0-9a-fA-F]{32}$/.test(vs));
}

function getTwilioClient() {
  if (!isTwilioAccountConfigured()) return null;
  return twilio(getTwilioAccountSid(), getTwilioAuthToken());
}

function twilioConfigStatus() {
  const accountSid = getTwilioAccountSid();
  const authToken = getTwilioAuthToken();
  const messagingSid = getTwilioMessagingServiceSid();
  const verifySid = getTwilioVerifyServiceSid();
  const phone = getTwilioPhoneNumber();
  const superAdminPhone = stripOuterQuotes(
    process.env.SUPER_ADMIN_SMS_PHONE || "",
  ).replace(/\s/g, "");

  return {
    accountConfigured: isTwilioAccountConfigured(),
    messagingConfigured: isTwilioMessagingConfigured(),
    verifyConfigured: isTwilioVerifyConfigured(),
    /** Presence-only diagnostics — never return secret values */
    env: {
      TWILIO_ACCOUNT_SID: {
        present: Boolean(accountSid),
        looksValid: Boolean(accountSid && accountSid.startsWith("AC")),
        prefix: accountSid ? `${accountSid.slice(0, 4)}…` : null,
      },
      TWILIO_AUTH_TOKEN: {
        present: Boolean(authToken),
        lengthOk: Boolean(authToken && authToken.length >= 16),
      },
      TWILIO_PHONE_NUMBER: {
        present: Boolean(phone),
        prefix: phone ? `${phone.slice(0, 3)}…` : null,
      },
      TWILIO_MESSAGING_SERVICE_SID: {
        present: Boolean(messagingSid),
        looksValid: Boolean(messagingSid && /^MG[0-9a-fA-F]{32}$/.test(messagingSid)),
        prefix: messagingSid ? `${messagingSid.slice(0, 4)}…` : null,
      },
      TWILIO_VERIFY_SERVICE_SID: {
        present: Boolean(verifySid),
        looksValid: Boolean(verifySid && /^VA[0-9a-fA-F]{32}$/.test(verifySid)),
        prefix: verifySid ? `${verifySid.slice(0, 4)}…` : null,
      },
      SUPER_ADMIN_SMS_PHONE: {
        present: Boolean(superAdminPhone),
        masked: superAdminPhone
          ? `••••${superAdminPhone.replace(/\D/g, "").slice(-4)}`
          : null,
      },
    },
    messagingServiceSidPrefix: messagingSid ? `${messagingSid.slice(0, 4)}…` : null,
    verifyServiceSidPrefix: verifySid ? `${verifySid.slice(0, 4)}…` : null,
    phoneNumberConfigured: Boolean(phone),
  };
}

module.exports = {
  stripOuterQuotes,
  getTwilioAccountSid,
  getTwilioAuthToken,
  getTwilioVerifyServiceSid,
  getTwilioMessagingServiceSid,
  getTwilioPhoneNumber,
  isTwilioAccountConfigured,
  isTwilioMessagingConfigured,
  isTwilioVerifyConfigured,
  getTwilioClient,
  twilioConfigStatus,
};
