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
  const operationalInsights = master && flagOn("AURA_PHASE3_OPERATIONAL_INSIGHTS");
  return {
    master,
    knowledge: master && flagOn("AURA_PHASE3_KNOWLEDGE"),
    conversation: master && flagOn("AURA_PHASE3_CONVERSATION"),
    /** Phase 3B1 — customer preferences (storage + consent). Default OFF. */
    customerPreferences: master && flagOn("AURA_PHASE3_CUSTOMER_PREFERENCES"),
    /** Phase 3B1 — suggestion prompts only; never auto-book. Default OFF. */
    preferenceSuggestions: master && flagOn("AURA_PHASE3_PREFERENCE_SUGGESTIONS"),
    /** Phase 3B2 — waitlist requests. Default OFF. */
    waitlist: master && flagOn("AURA_PHASE3_WAITLIST"),
    /** Phase 3B2 — open-slot recovery / offers. Default OFF. Requires waitlist. */
    slotRecovery: master && flagOn("AURA_PHASE3_SLOT_RECOVERY"),
    /** Phase 3B2 — outbound waitlist notifications. Default OFF. Separate approval. */
    waitlistNotifications: master && flagOn("AURA_PHASE3_WAITLIST_NOTIFICATIONS"),
    /**
     * Phase 3C — operational intelligence master (read-only reports).
     * Default OFF. Never grants automatic operational authority.
     */
    operationalInsights,
    /** Phase 3C — Super Admin insights dashboard API. Requires operationalInsights. */
    insightsDashboard: operationalInsights && flagOn("AURA_PHASE3_INSIGHTS_DASHBOARD"),
    /** Phase 3C — optional daily digest (send still separately gated). Requires operationalInsights. */
    insightsDailyDigest: operationalInsights && flagOn("AURA_PHASE3_INSIGHTS_DAILY_DIGEST"),
    /** Phase 3C — explainable recommendations (never auto-apply). Requires operationalInsights. */
    recommendations: operationalInsights && flagOn("AURA_PHASE3_RECOMMENDATIONS"),
  };
}

module.exports = {
  flagOn,
  isAuraPhase3Enabled,
  auraPhase3Flags,
};
