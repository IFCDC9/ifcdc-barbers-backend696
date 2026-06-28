/**
 * Process due 30-day haircut follow-up reminders (push notifications).
 * Usage: node scripts/process-haircut-followup-reminders.mjs
 */
import "../loadBackendEnv.mjs";
import { sendDueFollowupReminders } from "../socialPortfolioService.js";

const result = await sendDueFollowupReminders();
console.log(`[followup] sent ${result.sent} reminder(s).\n`);
