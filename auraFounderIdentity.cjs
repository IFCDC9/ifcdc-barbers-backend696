/**
 * AURA Founder Command Mode — identity constants.
 * Founder handset (+18484694448) is never the public AURA business line (+19895141064).
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const {
  getAuraOwnerAdminE164,
  getOfficialAuraBusinessE164,
  OFFICIAL_AURA_BUSINESS_E164,
} = require("./auraVoiceIntelligenceFlags.cjs");

const FOUNDER_VERIFIED_PHONE_E164 = "+18484694448";

const FOUNDER_IDENTITY = Object.freeze({
  name: "Fahreal Allah",
  spokenTitle: "Mister Allah",
  role: "Founder and Super Administrator",
  organization: "Imperial Foundation Community Development Center",
  platform: "IFCDC Barbers App",
  phoneE164: FOUNDER_VERIFIED_PHONE_E164,
  emailEnvKeys: ["AURA_FOUNDER_EMAIL", "BOOKING_ADMIN_EMAIL", "SUPER_ADMIN_EMAIL"],
  defaultEmail: "service@ifcdc.org",
});

/** Spoken founder greeting — always play in full before continuing. */
const FOUNDER_GREETING =
  "Welcome back, Mister Allah. This is AURA. I hope you're having a great day. I have the latest IFCDC Barbers App operational updates ready, including today's schedule, bookings, cancellations, reschedules, payment updates, and system activity. How may I assist you today?";

function founderPhoneE164() {
  const configured = getAuraOwnerAdminE164();
  const business = getOfficialAuraBusinessE164() || OFFICIAL_AURA_BUSINESS_E164;
  if (!configured || configured === business) return FOUNDER_VERIFIED_PHONE_E164;
  return configured;
}

function sameE164(a, b) {
  const na = normalizeToE164(a);
  const nb = normalizeToE164(b);
  if (!na.ok || !nb.ok) return false;
  return na.e164 === nb.e164;
}

function isFounderCaller(fromE164) {
  return sameE164(fromE164, founderPhoneE164());
}

function founderEmail() {
  for (const key of FOUNDER_IDENTITY.emailEnvKeys) {
    const v = String(process.env[key] || "").trim();
    if (v && v.includes("@")) return v;
  }
  return FOUNDER_IDENTITY.defaultEmail;
}

function founderPinConfigured() {
  return Boolean(String(process.env.AURA_OWNER_VOICE_PIN || "").trim());
}

/** Compare spoken/DTMF PIN — never log the raw PIN. */
function founderPinMatches(raw) {
  const expected = String(process.env.AURA_OWNER_VOICE_PIN || "").trim();
  if (!expected) return false;
  const digits = String(raw || "").replace(/\D/g, "");
  const expectedDigits = expected.replace(/\D/g, "");
  if (expectedDigits && digits === expectedDigits) return true;
  return String(raw || "").trim() === expected;
}

function maskPhonePartial(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••${digits.slice(-4)}`;
}

module.exports = {
  FOUNDER_IDENTITY,
  FOUNDER_VERIFIED_PHONE_E164,
  FOUNDER_GREETING,
  founderPhoneE164,
  isFounderCaller,
  founderEmail,
  founderPinConfigured,
  founderPinMatches,
  maskPhonePartial,
  sameE164,
};
