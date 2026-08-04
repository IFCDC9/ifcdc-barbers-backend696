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
  return {
    accountConfigured: isTwilioAccountConfigured(),
    messagingConfigured: isTwilioMessagingConfigured(),
    verifyConfigured: isTwilioVerifyConfigured(),
    messagingServiceSidPrefix: (() => {
      const s = getTwilioMessagingServiceSid();
      return s ? `${s.slice(0, 4)}…` : null;
    })(),
    verifyServiceSidPrefix: (() => {
      const s = getTwilioVerifyServiceSid();
      return s ? `${s.slice(0, 4)}…` : null;
    })(),
    phoneNumberConfigured: Boolean(getTwilioPhoneNumber()),
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
