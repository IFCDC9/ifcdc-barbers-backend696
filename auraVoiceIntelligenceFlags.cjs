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

/** Official IFCDC Barbers App / AURA customer-facing line (never the owner handset). */
const OFFICIAL_AURA_BUSINESS_E164 = "+19895141064";
/** Legacy Twilio long codes that must not be used as the official AURA identity. */
const LEGACY_TWILIO_LINES = new Set(["+13313168167", "+15309949546"]);

/** Official IFCDC Barbers App line (customer-facing). Does NOT fall back to TWILIO_PHONE_NUMBER. */
function getOfficialAuraBusinessE164() {
  const candidates = [
    process.env.AURA_PHONE_NUMBER,
    process.env.BUSINESS_PHONE,
    OFFICIAL_AURA_BUSINESS_E164,
  ];
  for (const c of candidates) {
    const raw = String(c || "")
      .trim()
      .replace(/\s/g, "");
    if (!raw) continue;
    if (LEGACY_TWILIO_LINES.has(raw)) continue;
    return raw;
  }
  return OFFICIAL_AURA_BUSINESS_E164;
}

/** Owner / admin handset for executive greeting (not customer display). */
function getAuraOwnerAdminE164() {
  const raw = String(
    process.env.AURA_OWNER_VOICE_PHONE || process.env.SUPER_ADMIN_SMS_PHONE || "+18484694448",
  )
    .trim()
    .replace(/\s/g, "");
  // Never treat the official business line as the owner handset.
  if (!raw || raw === OFFICIAL_AURA_BUSINESS_E164 || LEGACY_TWILIO_LINES.has(raw)) {
    return "+18484694448";
  }
  return raw;
}

module.exports = {
  envOn,
  auraVoiceIntelligenceFlags,
  isAuraVoiceIntelligencePhase1,
  getOfficialAuraBusinessE164,
  getAuraOwnerAdminE164,
  OFFICIAL_AURA_BUSINESS_E164,
  LEGACY_TWILIO_LINES,
};
