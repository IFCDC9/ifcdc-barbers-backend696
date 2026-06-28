/**
 * Process due 30-day haircut follow-up reminders (push notifications).
 * Usage: node scripts/process-haircut-followup-reminders.mjs
 *
 * Production: the web service runs this on boot and every 6 hours (see server.js).
 * Standalone cron requires DATABASE_URL on that Render service — prefer the web interval.
 */
import "../loadBackendEnv.mjs";

if (!String(process.env.DATABASE_URL || "").trim()) {
  console.warn("[followup] DATABASE_URL not set — skipping (configure on Render or use web service interval).\n");
  process.exit(0);
}

const { sendDueFollowupReminders } = await import("../socialPortfolioService.js");

try {
  const result = await sendDueFollowupReminders();
  console.log(`[followup] sent ${result.sent} reminder(s).\n`);
} catch (e) {
  console.error("[followup] failed:", e?.message || e);
  process.exit(1);
}
