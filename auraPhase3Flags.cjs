/**
 * AURA Phase 3 feature flags — all default OFF.
 * Do not enable in production until controlled E2E approval.
 */
function flagOn(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isAuraPhase3Enabled() {
  return flagOn("AURA_PHASE3_ENABLED");
}

function auraPhase3Flags() {
  const master = isAuraPhase3Enabled();
  return {
    master,
    knowledge: master && flagOn("AURA_PHASE3_KNOWLEDGE"),
    conversation: master && flagOn("AURA_PHASE3_CONVERSATION"),
    /** Phase 3B1 — customer preferences (storage + consent). Default OFF. */
    customerPreferences: master && flagOn("AURA_PHASE3_CUSTOMER_PREFERENCES"),
    /** Phase 3B1 — suggestion prompts only; never auto-book. Default OFF. */
    preferenceSuggestions: master && flagOn("AURA_PHASE3_PREFERENCE_SUGGESTIONS"),
    /** Deferred — Phase 3B2+ */
    waitlist: master && flagOn("AURA_PHASE3_WAITLIST"),
    slotRecovery: master && flagOn("AURA_PHASE3_SLOT_RECOVERY"),
    /** Deferred — Phase 3C */
    operationalInsights: master && flagOn("AURA_PHASE3_OPERATIONAL_INSIGHTS"),
  };
}

module.exports = {
  flagOn,
  isAuraPhase3Enabled,
  auraPhase3Flags,
};
