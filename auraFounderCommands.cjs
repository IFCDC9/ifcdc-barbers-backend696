/**
 * Founder voice command detection + protected-action helpers.
 */
const {
  buildFounderOperationalBriefing,
  speakFounderBriefing,
  speakChangesSince,
  resolveLastBriefingSince,
  googleCalendarStatus,
} = require("./auraFounderBriefing.cjs");
const { markFounderBriefingDelivered, recordFounderActivity } = require("./auraFounderAudit.cjs");
const {
  founderPinConfigured,
  founderPinMatches,
  FOUNDER_IDENTITY,
} = require("./auraFounderIdentity.cjs");
const {
  parseSpokenDateToYmd,
  parseSpokenTimeToSlotLabel,
  validateSelectedSlot,
  shopTimezone,
} = require("./auraVoiceIntelligenceBooking.cjs");

const FOUNDER_COMMANDS = [
  {
    cmd: "today_schedule",
    re: /\b((today'?s?|give me (the |my )?|what( is|'s)? (my |the )?|full )?schedule|what do i have( going on)? today|appointments? (happening |for )?today|today'?s? (full )?schedule)\b/i,
  },
  {
    cmd: "changes_since_last_call",
    re: /\b(what changed|changes? since|since (my )?last (call|briefing)|latest (booking )?activity|read( me)? all changes|what'?s new)\b/i,
  },
  {
    cmd: "who_booked_today",
    re: /\b(who booked( today)?|new bookings? today|bookings? created today)\b/i,
  },
  {
    cmd: "cancellations_today",
    re: /\b(did anyone cancel|who cancel+ed|cancellations?( today)?|cancelled today)\b/i,
  },
  {
    cmd: "reschedules_today",
    re: /\b(reschedul(ed|es?)|which appointments? were (moved|rescheduled)|moved appointments?)\b/i,
  },
  {
    cmd: "payments_pending",
    re: /\b(payments? (that are |are )?(still )?pending|unpaid|who hasn'?t paid|outstanding payments?)\b/i,
  },
  {
    cmd: "first_customer",
    re: /\b(first customer|who('?s| is) first)\b/i,
  },
  {
    cmd: "next_appointment",
    re: /\b(next appointment|what'?s next|who('?s| is) next)\b/i,
  },
  {
    cmd: "busiest_barber",
    re: /\b(busiest barber|which barber is busiest|most bookings)\b/i,
  },
  {
    cmd: "customer_problems",
    re: /\b(customer (problems?|issues?|complaints?)|escalations?|any (problems?|issues?))\b/i,
  },
  {
    cmd: "open_slots",
    re: /\b(open slots?|how many (open|free) slots?|slots? left)\b/i,
  },
  {
    cmd: "executive_brief",
    re: /\b(executive (brief|summary)|ops summary|operational summary|daily brief)\b/i,
  },
  {
    cmd: "book_for_me",
    re: /\b(book (a )?customer( for me)?|make (a |an )?appointment( for me)?|schedule (a )?customer)\b/i,
  },
  {
    cmd: "move_appointment",
    re: /\b(move (that |the )?appointment|reschedule (that |the )?appointment)\b/i,
  },
  {
    cmd: "cancel_appointment",
    re: /\b(cancel (that |the )?appointment)\b/i,
  },
];

const PROTECTED_CMDS = new Set(["book_for_me", "move_appointment", "cancel_appointment"]);

function detectFounderCommand(raw) {
  const text = String(raw || "").trim();
  if (!text) return { cmd: null, protected: false };
  for (const row of FOUNDER_COMMANDS) {
    if (row.re.test(text)) {
      return { cmd: row.cmd, protected: PROTECTED_CMDS.has(row.cmd) };
    }
  }
  // Broad schedule phrasing
  if (/\b(today|schedule|appointments?)\b/i.test(text) && /\b(what|give|tell|read|list)\b/i.test(text)) {
    return { cmd: "today_schedule", protected: false };
  }
  return { cmd: null, protected: false };
}

function pinGateReply() {
  if (!founderPinConfigured()) {
    return "That protected action needs your founder PIN. Please configure AURA_OWNER_VOICE_PIN, then say your PIN.";
  }
  return "That protected action needs your founder PIN first. Please say or enter your PIN. I will not change appointments without it.";
}

async function runFounderCommand({
  dbQuery,
  callSid,
  fromE164,
  raw,
  session,
  insertVoiceRow,
} = {}) {
  const detected = detectFounderCommand(raw);
  if (!detected.cmd) return null;

  await recordFounderActivity(dbQuery, {
    callSid,
    fromE164,
    eventKind: "founder_briefing_requested",
    ok: true,
    detail: { cmd: detected.cmd },
  });

  if (detected.protected && !session.ownerPinOk) {
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_requested",
      ok: false,
      detail: { cmd: detected.cmd, denied: "pin_required" },
    });
    session.pendingProtectedCmd = detected.cmd;
    session.pendingProtectedRaw = raw;
    return {
      handled: true,
      reply: pinGateReply(),
      intent: `founder_${detected.cmd}_pin_required`,
    };
  }

  if (detected.cmd === "book_for_me") {
    session.bookingStep = session.bookingStep || "service";
    session.bookingDraft = {
      ...(session.bookingDraft || {}),
      phone: fromE164,
      timezone: shopTimezone(),
      founderAssisted: true,
    };
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_requested",
      ok: true,
      detail: { cmd: "book_for_me" },
    });
    return {
      handled: true,
      reply:
        "Founder booking unlocked. Tell me the customer name, service, preferred barber or first available, and the date and time. I will only confirm after a successful database write.",
      intent: "founder_book_for_me",
      continueCustomerBooking: true,
    };
  }

  if (detected.cmd === "cancel_appointment" || detected.cmd === "move_appointment") {
    return handleFounderMutateAppointment({
      dbQuery,
      callSid,
      fromE164,
      raw,
      session,
      cmd: detected.cmd,
    });
  }

  const sinceIso =
    detected.cmd === "changes_since_last_call" ? await resolveLastBriefingSince(dbQuery) : null;
  let brief;
  try {
    brief = await buildFounderOperationalBriefing(dbQuery, {
      sinceIso: sinceIso || undefined,
    });
  } catch (e) {
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "founder_briefing_requested",
      ok: false,
      detail: { error: e?.message || String(e) },
    });
    return {
      handled: true,
      reply:
        "The live production booking database did not respond for this briefing. I have not invented any appointments. Please try again shortly.",
      intent: "founder_db_unavailable",
    };
  }

  if (!brief?.ok && detected.cmd === "today_schedule") {
    return {
      handled: true,
      reply:
        "I could not verify today's bookings from the production database. Source bookings_today failed. No appointments were invented.",
      intent: "founder_db_unavailable",
    };
  }

  const ex = brief.operational?.executive || {};
  let reply = "";

  switch (detected.cmd) {
    case "changes_since_last_call":
      if (!sinceIso) {
        reply =
          "I do not have a previous briefing timestamp yet. Here is today's operational summary instead. " +
          speakFounderBriefing(brief, { mode: "summary" });
      } else {
        reply = speakChangesSince(brief);
      }
      break;
    case "who_booked_today": {
      const list = (brief.operational?.appointments || []).slice(0, 10);
      reply = list.length
        ? `Bookings on today's calendar: ${list.map((a) => `${a.customerName} at ${a.timeLabel}`).join("; ")}.`
        : "There are no bookings on today's calendar in live records.";
      break;
    }
    case "cancellations_today": {
      const list = brief.operational?.cancelledToday || [];
      reply = list.length
        ? `Cancellations on record: ${list
            .slice(0, 8)
            .map((c) => `${c.customer_name || "Customer"}${c.cancellation_reason ? ` (${c.cancellation_reason})` : ""}`)
            .join("; ")}.`
        : "No cancellations are recorded for today in live records.";
      break;
    }
    case "reschedules_today": {
      const n = brief.operational?.rescheduledToday?.length || 0;
      reply = n
        ? `I see ${n} reschedule-related status notes from today in live records.`
        : "No reschedule activity is recorded for today in live records.";
      break;
    }
    case "payments_pending":
      reply = `There ${ex.paymentsPending === 1 ? "is" : "are"} ${ex.paymentsPending ?? 0} payment${ex.paymentsPending === 1 ? "" : "s"} still pending on today's active appointments.`;
      break;
    case "first_customer":
      reply = ex.firstCustomer
        ? `First customer today: ${ex.firstCustomer.customerName} at ${ex.firstCustomer.timeLabel} with ${ex.firstCustomer.barberName} for ${ex.firstCustomer.service}.`
        : "There is no first customer on today's active calendar.";
      break;
    case "next_appointment":
      reply = ex.nextAppointment
        ? `Next appointment: ${ex.nextAppointment.customerName} at ${ex.nextAppointment.timeLabel} with ${ex.nextAppointment.barberName}.`
        : "There is no upcoming appointment remaining today in live records.";
      break;
    case "busiest_barber":
      reply = ex.busiest
        ? `${ex.busiest.barberName} is busiest today with ${ex.busiest.count} appointments.`
        : "I cannot determine a busiest barber from today's live appointments.";
      break;
    case "customer_problems": {
      const esc = brief.operational?.escalations || [];
      const fail = brief.operational?.failedPayments || [];
      if (!esc.length && !fail.length) {
        reply = "No open customer escalations or failed-payment flags are on record right now.";
      } else {
        reply = `Customer issues: ${esc.length} open escalation${esc.length === 1 ? "" : "s"}, ${fail.length} failed or incomplete payment record${fail.length === 1 ? "" : "s"}.`;
      }
      break;
    }
    case "open_slots":
      reply =
        ex.availableSlots == null
          ? "Open slot count is unavailable from live availability right now."
          : `There ${ex.availableSlots === 1 ? "is" : "are"} ${ex.availableSlots} open slot${ex.availableSlots === 1 ? "" : "s"} remaining today across active barbers.`;
      break;
    case "executive_brief":
      reply = speakFounderBriefing(brief, { mode: "summary" });
      break;
    case "today_schedule":
    default:
      reply = speakFounderBriefing(brief, { mode: "full" });
      break;
  }

  await recordFounderActivity(dbQuery, {
    callSid,
    fromE164,
    eventKind: "records_included_in_briefing",
    ok: true,
    detail: {
      cmd: detected.cmd,
      appointmentCount: brief.operational?.appointments?.length || 0,
      sourcesFailed: (brief.sourcesFailed || []).map((s) => s.source),
    },
  });

  if (["today_schedule", "executive_brief", "changes_since_last_call"].includes(detected.cmd)) {
    await markFounderBriefingDelivered(dbQuery, { callSid, fromE164 });
  }

  // Calendar status explicit check command path already included in briefing
  if (/\b(personal )?calendar\b/i.test(raw) && !googleCalendarStatus().connected) {
    reply = `${googleCalendarStatus().spokenUnavailable} ${reply}`;
  }

  return {
    handled: true,
    reply,
    intent: `founder_${detected.cmd}`,
    briefMeta: { cmd: detected.cmd, founder: FOUNDER_IDENTITY.name },
  };
}

async function handleFounderMutateAppointment({ dbQuery, callSid, fromE164, raw, session, cmd }) {
  await recordFounderActivity(dbQuery, {
    callSid,
    fromE164,
    eventKind: "protected_action_requested",
    ok: true,
    detail: { cmd },
  });

  // Expect phrases like: "cancel John at 2 PM" / "move Maria to tomorrow at 3"
  const nameMatch = String(raw || "").match(
    /\b(?:for|cancel|move|reschedule)\s+([A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?)/i,
  );
  const customerHint = nameMatch?.[1] ? String(nameMatch[1]).trim() : "";
  const dateYmd = await parseSpokenDateToYmd(raw, shopTimezone());
  const timeLabel = await parseSpokenTimeToSlotLabel(raw);

  if (!customerHint) {
    return {
      handled: true,
      reply:
        cmd === "cancel_appointment"
          ? "Please say the customer name and appointment time to cancel, for example: cancel John at 2 PM."
          : "Please say the customer name and the new date and time, for example: move Maria to tomorrow at 3 PM.",
      intent: `founder_${cmd}_need_details`,
    };
  }

  let rows = [];
  try {
    const r = await dbQuery(
      `SELECT id, customer_name, phone, service, barber_name, barber_id, date, time,
              booking_status, payment_status
       FROM bookings
       WHERE deleted_at IS NULL
         AND lower(coalesce(booking_status,'')) NOT IN ('canceled','cancelled')
         AND lower(customer_name) LIKE lower($1)
       ORDER BY date ASC, time ASC
       LIMIT 5`,
      [`%${customerHint}%`],
    );
    rows = r.rows || [];
  } catch (e) {
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_completed_or_denied",
      ok: false,
      detail: { cmd, error: e?.message || String(e) },
    });
    return {
      handled: true,
      reply: "I could not look up that appointment in the production database. No change was made.",
      intent: `founder_${cmd}_db_error`,
    };
  }

  if (!rows.length) {
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_completed_or_denied",
      ok: false,
      detail: { cmd, denied: "not_found", customerHint },
    });
    return {
      handled: true,
      reply: `I do not see an active appointment for ${customerHint} in live records. No change was made.`,
      intent: `founder_${cmd}_not_found`,
    };
  }
  if (rows.length > 1 && !timeLabel) {
    return {
      handled: true,
      reply: `I found more than one appointment for ${customerHint}. Please include the appointment time.`,
      intent: `founder_${cmd}_ambiguous`,
    };
  }

  const booking = rows[0];

  if (cmd === "cancel_appointment") {
    try {
      const upd = await dbQuery(
        `UPDATE bookings SET
           booking_status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = 'founder_voice',
           cancellation_reason = $2,
           updated_at = NOW()
         WHERE id = $1::uuid AND deleted_at IS NULL
         RETURNING id, booking_status`,
        [booking.id, "Cancelled by founder via AURA voice"],
      );
      if (!upd.rows?.length) {
        throw new Error("update_failed");
      }
      const { emitFounderEvent } = require("./auraFounderNotify.cjs");
      void emitFounderEvent(dbQuery, {
        eventType: "appointment_cancelled",
        bookingId: booking.id,
        customerName: booking.customer_name,
        customerPhone: booking.phone,
        barberName: booking.barber_name,
        serviceName: booking.service,
        originalDate: booking.date,
        originalTime: booking.time,
        cancellationReason: "Cancelled by founder via AURA voice",
        paymentStatus: booking.payment_status,
        bookingStatus: "cancelled",
        actionRequired: false,
        source: "aura_founder_voice",
      });
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "protected_action_completed_or_denied",
        ok: true,
        detail: { cmd, bookingId: booking.id },
      });
      return {
        handled: true,
        reply: `Cancelled. Confirmation ${String(booking.id).replace(/-/g, "").slice(0, 8).toUpperCase()} for ${booking.customer_name} is now cancelled in the production database.`,
        intent: "founder_cancel_ok",
      };
    } catch (e) {
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "protected_action_completed_or_denied",
        ok: false,
        detail: { cmd, error: e?.message || String(e) },
      });
      return {
        handled: true,
        reply: "I'm unable to finalize that cancellation right now. The appointment was not changed.",
        intent: "founder_cancel_fail",
      };
    }
  }

  // move / reschedule
  if (!dateYmd || !timeLabel) {
    return {
      handled: true,
      reply: "Please include the new date and time, for example tomorrow at 3 PM.",
      intent: "founder_move_need_time",
    };
  }
  const check = await validateSelectedSlot({
    barberId: booking.barber_id,
    barberName: booking.barber_name,
    dateYmd,
    timeLabel,
    durationMinutes: 30,
  });
  if (!check.ok) {
    return {
      handled: true,
      reply: `That new time is not available. ${check.message || ""} No change was made.`.trim(),
      intent: "founder_move_slot_unavailable",
    };
  }
  try {
    const upd = await dbQuery(
      `UPDATE bookings SET
         date = $2::date,
         time = $3::time,
         booking_status = COALESCE(NULLIF(booking_status,''), 'confirmed'),
         updated_at = NOW()
       WHERE id = $1::uuid AND deleted_at IS NULL
       RETURNING id, date, time`,
      [booking.id, dateYmd, timeLabel],
    );
    if (!upd.rows?.length) throw new Error("update_failed");
    const { emitFounderEvent } = require("./auraFounderNotify.cjs");
    void emitFounderEvent(dbQuery, {
      eventType: "appointment_rescheduled",
      bookingId: booking.id,
      customerName: booking.customer_name,
      customerPhone: booking.phone,
      barberName: booking.barber_name,
      serviceName: booking.service,
      originalDate: booking.date,
      originalTime: booking.time,
      newDate: dateYmd,
      newTime: timeLabel,
      paymentStatus: booking.payment_status,
      bookingStatus: booking.booking_status,
      actionRequired: false,
      source: "aura_founder_voice",
    });
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_completed_or_denied",
      ok: true,
      detail: { cmd, bookingId: booking.id, dateYmd, timeLabel },
    });
    return {
      handled: true,
      reply: `Rescheduled ${booking.customer_name} to ${dateYmd} at ${timeLabel}. Confirmation ${String(booking.id).replace(/-/g, "").slice(0, 8).toUpperCase()}.`,
      intent: "founder_move_ok",
    };
  } catch (e) {
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "protected_action_completed_or_denied",
      ok: false,
      detail: { cmd, error: e?.message || String(e) },
    });
    return {
      handled: true,
      reply: "I'm unable to finalize that reschedule right now. The appointment was not changed.",
      intent: "founder_move_fail",
    };
  }
}

function tryFounderPinTurn(session, raw, { callSid, fromE164, dbQuery } = {}) {
  const digits = String(raw || "").replace(/\D/g, "");
  const looksLikePin =
    /\b(pin|passcode|security)\b/i.test(raw) || (/^\d{4,8}$/.test(digits) && !session.ownerPinOk);
  if (!looksLikePin) return null;

  if (founderPinMatches(raw)) {
    session.ownerPinOk = true;
    void recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "owner_pin_verified",
      ok: true,
      detail: {},
    });
    void recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "founder_identity_verified",
      ok: true,
      detail: { method: "cli_plus_pin" },
    });
    return {
      handled: true,
      reply:
        "Founder PIN verified. Protected administrative actions are unlocked for this call. What would you like next?",
      intent: "founder_pin_ok",
      resumeProtected: session.pendingProtectedCmd || null,
    };
  }
  if (/^\d{4,8}$/.test(digits)) {
    void recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "owner_pin_verified",
      ok: false,
      detail: { denied: true },
    });
    return {
      handled: true,
      reply:
        "That PIN was not accepted. Sensitive customer changes, refunds, staff edits, and system settings remain locked. You can still request today's operational briefing.",
      intent: "founder_pin_fail",
    };
  }
  return {
    handled: true,
    reply: pinGateReply(),
    intent: "founder_pin_prompt",
  };
}

module.exports = {
  FOUNDER_COMMANDS,
  detectFounderCommand,
  runFounderCommand,
  tryFounderPinTurn,
  pinGateReply,
  PROTECTED_CMDS,
};
