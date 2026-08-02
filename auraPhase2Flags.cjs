/**
 * AURA Phase 2 feature flags — all default OFF.
 * Production activation requires explicit env + operator approval.
 */
function flagOn(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isAuraPhase2Enabled() {
  return flagOn("AURA_PHASE2_ENABLED");
}

function auraPhase2Flags() {
  const master = isAuraPhase2Enabled();
  return {
    master,
    reminders24h: master && flagOn("AURA_PHASE2_REMINDERS_24H"),
    reminders2h: master && flagOn("AURA_PHASE2_REMINDERS_2H"),
    /** Keep legacy ~30m scanner optional under Phase 2 master */
    reminders30m: master && flagOn("AURA_PHASE2_REMINDERS_30M"),
    barberNotify: master && flagOn("AURA_PHASE2_BARBER_NOTIFY"),
    adminAlerts: master && flagOn("AURA_PHASE2_ADMIN_ALERTS"),
    toolsEnabled: master && flagOn("AURA_PHASE2_TOOLS_ENABLED"),
    reviewFollowup: master && flagOn("AURA_PHASE2_REVIEW_FOLLOWUP"),
    /** Foundation only — never auto-send from this flag alone */
    dailyReportPreview: master && flagOn("AURA_DAILY_REPORT_PREVIEW"),
    /** Explicit second step — must stay off until report data verified */
    dailyReportSend: master && flagOn("AURA_DAILY_REPORT_ENABLED"),
    /** Optional: AURA-branded reschedule email in addition to existing confirmation */
    rescheduleEmailExtra: master && flagOn("AURA_PHASE2_RESCHEDULE_EMAIL"),
  };
}

function auraReceptionistIdentity() {
  return "AURA, the IFCDC Barbers digital receptionist";
}

module.exports = {
  flagOn,
  isAuraPhase2Enabled,
  auraPhase2Flags,
  auraReceptionistIdentity,
};
