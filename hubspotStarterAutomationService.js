/**
 * HubSpot Starter production automations.
 *
 * Marketing Hub Starter cannot enroll contacts into property-triggered Workflows
 * (Professional+) and Simple Automations only react to *email engagement*
 * (open/click), not registration/booking CRM events.
 *
 * Supported Starter path:
 * - Sync CRM properties to HubSpot (contacts/companies/deals) — already in hubspotService
 * - Deliver the six IFCDC emails via Resend (transactional), optionally trying
 *   HubSpot single-send first when the portal has that entitlement
 * - Never block registration, booking, PayPal, or completion
 */
import { createRequire } from "module";
import { dbQuery } from "./db.js";
import {
  isHubSpotConfigured,
  isHubSpotSyncEnabled,
  isHubSpotWorkflowSyncEnabled,
} from "./hubspotService.js";

const require = createRequire(import.meta.url);
const { sendEmail, isResendConfigured } = require("./emailResend.cjs");

const API = "https://api.hubapi.com";

/** Canonical six IFCDC automations for Starter production. */
export const STARTER_AUTOMATIONS = [
  {
    key: "welcome",
    name: "IFCDC — Welcome email",
    emailName: "IFCDC Welcome",
    emailId: "371937549002",
    subject: "Welcome to IFCDC Barbers",
    html: "<p>Welcome to IFCDC Barbers. Your account is ready — book your next cut in the app or on the web.</p><p>— IFCDC Barbers</p>",
    trigger: "New client / barber / shop-owner registration (contact sync reason register*)",
    channel: "resend_with_hubspot_singlesend_attempt",
    hubspotPropertySignal: "ifcdc_lifecycle_stage=registered",
  },
  {
    key: "confirmation",
    name: "IFCDC — Appointment confirmation",
    emailName: "IFCDC Appointment Confirmation",
    emailId: "371945586401",
    subject: "Your IFCDC appointment is confirmed",
    html: null, // delivered by bookingEmail.cjs (Resend) — do not double-send
    trigger: "Paid booking finalize (PayPal capture)",
    channel: "resend_booking_email",
    hubspotPropertySignal: "ifcdc_confirmation_ready=true / deal paid",
  },
  {
    key: "review",
    name: "IFCDC — Review request",
    emailName: "IFCDC Review Request",
    emailId: "371940161243",
    subject: "How was your IFCDC appointment?",
    html: null, // delivered by reviewNotificationEmail.cjs — do not double-send
    trigger: "Booking marked completed",
    channel: "resend_review_prompt",
    hubspotPropertySignal: "ifcdc_review_requested=true",
  },
  {
    key: "rebook",
    name: "IFCDC — Rebooking reminder",
    emailName: "IFCDC Rebooking Reminder",
    emailId: "371940161246",
    subject: "Time for your next IFCDC cut?",
    html: "<p>Ready for your next cut? Book again with IFCDC Barbers when it works for you.</p><p><a href=\"https://ifcdcbarbersapp.com/booking\">Book now</a></p><p>— IFCDC Barbers</p>",
    trigger: "Appointment completed (rebook eligible contact refresh)",
    channel: "resend_with_hubspot_singlesend_attempt",
    hubspotPropertySignal: "ifcdc_rebook_eligible=true",
  },
  {
    key: "birthday",
    name: "IFCDC — Birthday promotion",
    emailName: "IFCDC Birthday Promotion",
    emailId: "371937549005",
    subject: "Happy birthday from IFCDC Barbers",
    html: "<p>Happy birthday from IFCDC Barbers — treat yourself to a fresh cut.</p><p><a href=\"https://ifcdcbarbersapp.com/booking\">Book a birthday cut</a></p><p>— IFCDC Barbers</p>",
    trigger: "Contact has date_of_birth on register/profile sync",
    channel: "resend_with_hubspot_singlesend_attempt",
    hubspotPropertySignal: "ifcdc_date_of_birth / date_of_birth",
  },
  {
    key: "loyalty",
    name: "IFCDC — Loyalty reward notification",
    emailName: "IFCDC Loyalty Reward",
    emailId: "371951628008",
    subject: "Your IFCDC loyalty update",
    html: "<p>Your IFCDC loyalty points were updated. Keep booking to unlock rewards.</p><p><a href=\"https://ifcdcbarbersapp.com\">Open IFCDC Barbers</a></p><p>— IFCDC Barbers</p>",
    trigger: "Appointment completed loyalty earn/redeem refresh",
    channel: "resend_with_hubspot_singlesend_attempt",
    hubspotPropertySignal: "ifcdc_loyalty_last_event",
  },
];

function getKey() {
  return String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
}

function envFlag(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Kill-switch: HUBSPOT_STARTER_AUTOMATIONS=0 disables Resend side of starter automations. */
export function isHubSpotStarterAutomationsEnabled() {
  if (!isHubSpotConfigured() || !isHubSpotSyncEnabled()) return false;
  if (process.env.HUBSPOT_STARTER_AUTOMATIONS == null || process.env.HUBSPOT_STARTER_AUTOMATIONS === "") {
    return true;
  }
  return envFlag("HUBSPOT_STARTER_AUTOMATIONS");
}

function byKey(key) {
  return STARTER_AUTOMATIONS.find((a) => a.key === key) || null;
}

async function recordAutomationEvent({ key, email, status, message = null, httpStatus = null }) {
  try {
    await dbQuery(
      `INSERT INTO hubspot_sync_events (entity_type, local_id, action, status, http_status, message)
       VALUES ('starter_automation', $1, $2, $3, $4, $5)`,
      [String(email || "").slice(0, 180), `starter_${key}`, status, httpStatus, message],
    );
  } catch {
    // never throw
  }
}

async function alreadySentRecently(key, email, withinHours = 24) {
  try {
    const row = await dbQuery(
      `SELECT 1 FROM hubspot_sync_events
       WHERE entity_type = 'starter_automation'
         AND local_id = $1
         AND action = $2
         AND status IN ('ok', 'sent', 'hubspot_sent', 'resend_sent')
         AND created_at > NOW() - ($3::int * INTERVAL '1 hour')
       LIMIT 1`,
      [String(email || "").toLowerCase(), `starter_${key}`, Number(withinHours) || 24],
    );
    return Boolean(row.rows?.[0]);
  } catch {
    return false;
  }
}

async function tryHubSpotSingleSend({ emailId, to, contactProperties = {} }) {
  const key = getKey();
  if (!key || !emailId || !to) {
    return { ok: false, skipped: true, reason: "missing_inputs" };
  }
  const paths = [
    "/marketing/v3/transactional/single-email/send",
    "/marketing/v3/email/single-send",
  ];
  const body = {
    emailId: String(emailId),
    message: { to: String(to) },
    contactProperties,
  };
  let last = null;
  for (const path of paths) {
    try {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      last = {
        ok: res.ok,
        http: res.status,
        path,
        message: json?.message || null,
        category: json?.category || null,
      };
      if (res.ok) return { ok: true, channel: "hubspot_singlesend", ...last };
    } catch (error) {
      last = { ok: false, path, message: String(error?.message || error).slice(0, 160) };
    }
  }
  return { ok: false, channel: "hubspot_singlesend", ...(last || { reason: "all_paths_failed" }) };
}

async function sendViaResend({ to, subject, html }) {
  if (!isResendConfigured()) {
    return { ok: false, skipped: true, reason: "resend_not_configured" };
  }
  if (!to || !subject || !html) {
    return { ok: false, skipped: true, reason: "missing_email_content" };
  }
  try {
    const result = await sendEmail({ to, subject, html });
    if (result?.ok === false) {
      return { ok: false, channel: "resend", message: result?.error || result?.message || "send_failed" };
    }
    return { ok: true, channel: "resend", messageId: result?.id || result?.messageId || null };
  } catch (error) {
    return { ok: false, channel: "resend", message: String(error?.message || error).slice(0, 180) };
  }
}

/**
 * Deliver one Starter automation email (HubSpot single-send attempt → Resend).
 * Safe: never throws.
 */
export async function runStarterAutomationEmail(key, { to, name = null, force = false } = {}) {
  const spec = byKey(key);
  if (!spec) return { ok: false, reason: "unknown_key" };
  if (!isHubSpotStarterAutomationsEnabled()) {
    return { ok: false, skipped: true, reason: "starter_automations_disabled" };
  }
  // confirmation + review are owned by existing Resend modules — callers should not use this.
  if (spec.channel === "resend_booking_email" || spec.channel === "resend_review_prompt") {
    return {
      ok: true,
      skipped: true,
      reason: "owned_by_existing_resend_module",
      channel: spec.channel,
      automation: spec.key,
    };
  }
  if (!spec.html) {
    return { ok: false, skipped: true, reason: "no_html_template" };
  }

  const email = String(to || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, skipped: true, reason: "missing_to" };
  }

  if (!force && (await alreadySentRecently(key, email, key === "welcome" ? 168 : 48))) {
    return { ok: true, skipped: true, reason: "already_sent_recently", automation: key };
  }

  const hs = await tryHubSpotSingleSend({
    emailId: spec.emailId,
    to: email,
    contactProperties: name ? { firstname: String(name).split(/\s+/)[0] || "" } : {},
  });
  if (hs.ok) {
    await recordAutomationEvent({
      key,
      email,
      status: "hubspot_sent",
      httpStatus: hs.http,
      message: hs.path,
    });
    return { ok: true, channel: "hubspot_singlesend", automation: key, hubspot: hs };
  }

  const rs = await sendViaResend({ to: email, subject: spec.subject, html: spec.html });
  if (rs.ok) {
    await recordAutomationEvent({
      key,
      email,
      status: "resend_sent",
      message: `hubspot_blocked:${hs.http || hs.message || "n/a"};resend_ok`,
    });
    return {
      ok: true,
      channel: "resend",
      automation: key,
      hubspotAttempt: hs,
      resend: rs,
      note: "HubSpot single-send unavailable on Starter without transactional add-on; Resend delivered.",
    };
  }

  await recordAutomationEvent({
    key,
    email,
    status: "error",
    httpStatus: hs.http || null,
    message: `hubspot:${hs.message || hs.reason};resend:${rs.message || rs.reason}`,
  });
  return { ok: false, automation: key, hubspotAttempt: hs, resend: rs };
}

/** Fire-and-forget welcome after registration contact sync. */
export function enqueueStarterWelcome({ email, name, reason = "" } = {}) {
  try {
    if (!isHubSpotStarterAutomationsEnabled()) return;
    if (!/register|signup|google_register|apple_register/i.test(String(reason || ""))) return;
    const to = String(email || "").trim();
    if (!to) return;
    void runStarterAutomationEmail("welcome", { to, name }).catch((error) => {
      console.warn("[hubspot-starter] welcome failed:", error?.message || error);
    });
  } catch (error) {
    console.warn("[hubspot-starter] welcome enqueue failed:", error?.message || error);
  }
}

/** Fire-and-forget post-completion loyalty + rebook emails. */
export function enqueueStarterCompletionAutomations({
  email,
  name,
  sendLoyalty = true,
  sendRebook = true,
  sendBirthday = false,
} = {}) {
  try {
    if (!isHubSpotStarterAutomationsEnabled() || !isHubSpotWorkflowSyncEnabled()) return;
    const to = String(email || "").trim();
    if (!to) return;
    if (sendLoyalty) {
      void runStarterAutomationEmail("loyalty", { to, name }).catch((e) =>
        console.warn("[hubspot-starter] loyalty failed:", e?.message || e),
      );
    }
    if (sendRebook) {
      void runStarterAutomationEmail("rebook", { to, name }).catch((e) =>
        console.warn("[hubspot-starter] rebook failed:", e?.message || e),
      );
    }
    if (sendBirthday) {
      void runStarterAutomationEmail("birthday", { to, name }).catch((e) =>
        console.warn("[hubspot-starter] birthday failed:", e?.message || e),
      );
    }
  } catch (error) {
    console.warn("[hubspot-starter] completion enqueue failed:", error?.message || error);
  }
}

export function getStarterAutomationCatalog() {
  return STARTER_AUTOMATIONS.map((a) => ({
    key: a.key,
    name: a.name,
    emailName: a.emailName,
    emailId: a.emailId,
    trigger: a.trigger,
    channel: a.channel,
    hubspotPropertySignal: a.hubspotPropertySignal,
  }));
}
