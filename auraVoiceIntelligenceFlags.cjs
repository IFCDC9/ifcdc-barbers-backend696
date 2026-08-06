/**
 * AURA Voice Intelligence Phase 1 — default OFF (production voice unchanged until enabled).
 * Does not alter Twilio Verify, SMS flags, booking, or PayPal configuration.
 */
function envOn(name, defaultOn = false) {
  const raw = String(process.env[name] ?? (defaultOn ? "1" : "0"))
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return defaultOn;
}

function auraVoiceIntelligenceFlags() {
  return {
    /** Master Phase 1 intelligence orchestrator on simple voice /process */
    phase1Enabled: envOn("AURA_VOICE_INTELLIGENCE_PHASE_1", false),
    /** Persist call legs / turns when Phase 1 is on */
    callLogging: envOn("AURA_VOICE_INTEL_CALL_LOGGING", true),
    /** Persist caller operational memory (name, prefs) keyed by E.164 */
    callerMemory: envOn("AURA_VOICE_INTEL_CALLER_MEMORY", true),
  };
}

function isAuraVoiceIntelligencePhase1() {
  return auraVoiceIntelligenceFlags().phase1Enabled;
}

/** Official IFCDC Barbers App line (customer-facing). */
function getOfficialAuraBusinessE164() {
  const raw = String(
    process.env.AURA_PHONE_NUMBER ||
      process.env.BUSINESS_PHONE ||
      process.env.TWILIO_PHONE_NUMBER ||
      "+19895141064",
  ).trim();
  return raw.replace(/\s/g, "") || "+19895141064";
}

/** Owner / admin handset for executive greeting (not customer display). */
function getAuraOwnerAdminE164() {
  const raw = String(
    process.env.AURA_OWNER_VOICE_PHONE || process.env.SUPER_ADMIN_SMS_PHONE || "+18484694448",
  ).trim();
  return raw.replace(/\s/g, "") || "+18484694448";
}

module.exports = {
  envOn,
  auraVoiceIntelligenceFlags,
  isAuraVoiceIntelligencePhase1,
  getOfficialAuraBusinessE164,
  getAuraOwnerAdminE164,
};
