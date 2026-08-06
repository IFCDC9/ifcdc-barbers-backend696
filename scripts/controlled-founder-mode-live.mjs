#!/usr/bin/env node
/**
 * Controlled founder command-mode checks against production DB (read + event emit).
 * Does not change Twilio / Verify / PayPal / A2P / official business number.
 *
 *   CONFIRM_LIVE_FOUNDER_MODE=1 node --import ./loadBackendEnv.mjs scripts/controlled-founder-mode-live.mjs
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { ensureAuraFounderSchema } = require("../auraFounderMigrations.cjs");
const { FOUNDER_GREETING, isFounderCaller } = require("../auraFounderIdentity.cjs");
const {
  buildFounderOperationalBriefing,
  speakFounderBriefing,
  googleCalendarStatus,
} = require("../auraFounderBriefing.cjs");
const { emitFounderEvent } = require("../auraFounderNotify.cjs");
const { detectFounderCommand, runFounderCommand } = require("../auraFounderCommands.cjs");
const { markFounderBriefingDelivered, getFounderState } = require("../auraFounderAudit.cjs");
const { dbQuery } = await import("../db.js");

if (process.env.CONFIRM_LIVE_FOUNDER_MODE !== "1") {
  console.error("Set CONFIRM_LIVE_FOUNDER_MODE=1 to run.");
  process.exit(2);
}

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(detail));
}

async function main() {
  console.log("=== Controlled founder command mode live tests ===");
  record("founder_cli_recognition", isFounderCaller("+18484694448") === true);
  record("public_line_not_founder", isFounderCaller("+19895141064") === false);
  record("greeting_copy", /operational information ready/i.test(FOUNDER_GREETING));

  await ensureAuraFounderSchema(dbQuery);
  record("schema_ok", true);

  const cal = googleCalendarStatus();
  record("calendar_not_connected", cal.connected === false, {
    message: cal.spokenUnavailable.slice(0, 80),
  });

  let briefOk = false;
  let brief;
  try {
    brief = await buildFounderOperationalBriefing(dbQuery);
    briefOk = Boolean(brief?.ok);
    const spoken = speakFounderBriefing(brief, { mode: "summary" });
    record("today_schedule_briefing", briefOk, {
      appointments: brief?.operational?.appointments?.length ?? null,
      sourcesFailed: (brief?.sourcesFailed || []).map((s) => s.source),
      spokenPreview: spoken.slice(0, 160),
    });
  } catch (e) {
    record("today_schedule_briefing", false, { error: e?.message || String(e) });
  }

  // Simulate DB unavailable path (bookings query fails)
  const badDb = async () => {
    throw new Error("simulated_db_down");
  };
  const badBrief = await buildFounderOperationalBriefing(badDb);
  record("db_unavailable_detected", badBrief?.ok === false, {
    sourcesFailed: (badBrief?.sourcesFailed || []).map((s) => s.source),
  });

  const session = { ownerPinOk: false, bookingDraft: {} };
  const scheduleCmd = detectFounderCommand("Give me today's full schedule.");
  record("detect_today_schedule", scheduleCmd.cmd === "today_schedule");

  const cmdOut = await runFounderCommand({
    dbQuery,
    callSid: `founder_ctrl_${randomUUID().slice(0, 8)}`,
    fromE164: "+18484694448",
    raw: "Give me today's full schedule.",
    session,
  });
  record("run_today_schedule_command", Boolean(cmdOut?.handled && cmdOut.reply), {
    intent: cmdOut?.intent || null,
  });

  await markFounderBriefingDelivered(dbQuery, {
    callSid: "founder_ctrl_brief",
    fromE164: "+18484694448",
  });
  const state = await getFounderState(dbQuery);
  record("last_briefing_timestamp_set", Boolean(state?.last_briefing_at), {
    last_briefing_at: state?.last_briefing_at || null,
  });

  const evt = await emitFounderEvent(dbQuery, {
    eventType: "new_booking_created",
    customerName: "Founder Mode Live Probe",
    customerPhone: "+18484694448",
    barberName: "IFCDC Barbers",
    serviceName: "Probe",
    paymentStatus: "pending",
    bookingStatus: "pending",
    actionRequired: false,
    source: "controlled_founder_test",
    payload: { probe: true },
  });
  record("new_booking_notification_event", Boolean(evt?.ok && evt.event?.id), {
    eventId: evt?.event?.id || null,
    channels: (evt?.delivery?.channels || []).map((c) => `${c.channel}:${c.ok ? "ok" : "no"}`),
  });

  // Changes since last call should see the event
  const sinceOut = await runFounderCommand({
    dbQuery,
    callSid: `founder_ctrl_${randomUUID().slice(0, 8)}`,
    fromE164: "+18484694448",
    raw: "What changed since my last call?",
    session: { ownerPinOk: false },
  });
  record("changes_since_last_call", Boolean(sinceOut?.handled), {
    intent: sinceOut?.intent || null,
    preview: String(sinceOut?.reply || "").slice(0, 160),
  });

  // Payment / reschedule / cancel event types
  for (const eventType of [
    "appointment_rescheduled",
    "appointment_cancelled",
    "booking_payment_completed",
    "booking_payment_failed",
  ]) {
    const e = await emitFounderEvent(dbQuery, {
      eventType,
      customerName: "Founder Mode Live Probe",
      source: "controlled_founder_test",
      actionRequired: eventType.includes("failed"),
    });
    record(`event_${eventType}`, Boolean(e?.ok), { id: e?.event?.id || null });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(
    JSON.stringify(
      {
        ok: passed === results.length,
        passed,
        total: results.length,
        calendar: cal.connected ? "connected" : "not_connected",
        results,
      },
      null,
      2,
    ),
  );
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
