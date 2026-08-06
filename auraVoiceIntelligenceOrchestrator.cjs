/**
 * AURA Voice Intelligence Phase 1 orchestrator.
 * Used only when AURA_VOICE_INTELLIGENCE_PHASE_1 is on.
 * Falls through to legacy simple booking when orchestrator returns useLegacyBooking=true.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const {
  isAuraVoiceIntelligencePhase1,
  getAuraOwnerAdminE164,
  getOfficialAuraBusinessE164,
} = require("./auraVoiceIntelligenceFlags.cjs");
const {
  detectCallerIntents,
  detectPaymentCardRisk,
  intentSpokenLabel,
} = require("./auraVoiceIntelligenceIntents.cjs");
const {
  listActiveBarbers,
  listPublicServices,
  resolveShopContact,
  findBookingsByPhone,
  ownerTodaySummary,
  ownerNewCustomerCount,
  speakUnavailable,
  formatServiceList,
  formatBarberList,
} = require("./auraVoiceIntelligenceTools.cjs");
const {
  upsertCall,
  appendTurn,
  finalizeCall,
  recordAction,
  getCallerProfile,
  touchCallerProfile,
  createEscalation,
} = require("./auraVoiceIntelligenceLog.cjs");

/** In-memory session per CallSid (operational only). */
const sessions = new Map();
const SESSION_CAP = 2000;

function getSession(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return null;
  if (!sessions.has(k)) {
    while (sessions.size >= SESSION_CAP) {
      const first = sessions.keys().next().value;
      sessions.delete(first);
    }
    sessions.set(k, {
      greeted: false,
      ownerVerified: false,
      ownerPinOk: false,
      humanAsks: 0,
      bookingFails: 0,
      pendingIntents: [],
      bookingDraft: {},
      bookingStep: null,
      lastIntent: null,
      disclosedProfile: false,
    });
  }
  return sessions.get(k);
}

function sameE164(a, b) {
  const na = normalizeToE164(a);
  const nb = normalizeToE164(b);
  if (!na.ok || !nb.ok) return false;
  return na.e164 === nb.e164;
}

function isOwnerCaller(fromE164) {
  return sameE164(fromE164, getAuraOwnerAdminE164());
}

function ownerPinConfigured() {
  return Boolean(String(process.env.AURA_OWNER_VOICE_PIN || "").trim());
}

function ownerPinMatches(raw) {
  const expected = String(process.env.AURA_OWNER_VOICE_PIN || "").trim();
  if (!expected) return false;
  const digits = String(raw || "").replace(/\D/g, "");
  return digits === expected.replace(/\D/g, "") || String(raw || "").trim() === expected;
}

function pronounceIfcdc(text) {
  return String(text || "")
    .replace(/\bIFCDC\b/g, "I F C D C")
    .replace(/\bIfcdc\b/g, "I F C D C");
}

function parseDay(raw) {
  const s = String(raw || "").toLowerCase();
  const t = new Date();
  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  if (/\btomorrow\b/.test(s)) {
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  if (/\btoday\b/.test(s)) return ymd(t);
  const iso = String(raw || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : "";
}

function parseTime(raw) {
  const lower = String(raw || "").toLowerCase();
  if (/\b(morning|early)\b/.test(lower)) return "10:00";
  if (/\b(afternoon)\b/.test(lower)) return "14:00";
  if (/\b(evening)\b/.test(lower)) return "17:00";
  const ampm = String(raw || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const mi = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const ap = String(ampm[3]).toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  return "";
}

function isYes(t) {
  return /\b(yes|yeah|yep|correct|right|confirm)\b/i.test(t);
}
function isNo(t) {
  return /\b(no|nope|change|wrong)\b/i.test(t);
}

/**
 * @returns {Promise<{
 *   handled: boolean,
 *   useLegacyBooking?: boolean,
 *   reply?: string,
 *   hangup?: boolean,
 *   afterBookingClose?: boolean,
 *   intent?: string,
 *   callId?: string
 * }>}
 */
async function runVoiceIntelligenceTurn({
  dbQuery,
  callSid,
  from,
  to,
  userInput,
  insertVoiceRow,
  language = "en",
} = {}) {
  if (!isAuraVoiceIntelligencePhase1()) {
    return { handled: false, useLegacyBooking: true };
  }

  const session = getSession(callSid) || getSession(callSid || `anon_${Date.now()}`);
  const fromNorm = normalizeToE164(from);
  const fromE164 = fromNorm.ok ? fromNorm.e164 : String(from || "").trim() || null;
  const toE164 = (() => {
    const n = normalizeToE164(to || getOfficialAuraBusinessE164());
    return n.ok ? n.e164 : getOfficialAuraBusinessE164();
  })();
  const owner = Boolean(fromE164 && isOwnerCaller(fromE164));
  const raw = String(userInput || "").trim();
  const isWelcome = raw === "__IFCDC_VOICE_WELCOME__" || raw.toLowerCase() === "hello";
  const isSilence = raw === "__IFCDC_NO_SPEECH__";

  const cardRisk = detectPaymentCardRisk(raw);
  if (cardRisk.blocked) {
    return {
      handled: true,
      reply: pronounceIfcdc(cardRisk.reply),
      intent: "payment_safety",
    };
  }

  const intents = detectCallerIntents(isWelcome || isSilence ? "" : raw);
  const callId = await upsertCall(dbQuery, {
    callSid,
    fromE164,
    toE164,
    verifiedStatus: owner ? "owner_cli" : fromE164 ? "cli_present" : "unverified",
    isOwner: owner,
    primaryIntent: intents.primary,
    intents: intents.all,
  }).catch(() => null);

  let profile = null;
  if (fromE164) {
    profile = await getCallerProfile(dbQuery, fromE164).catch(() => null);
    await touchCallerProfile(dbQuery, fromE164, {
      languagePref: language,
    }).catch(() => null);
  }

  const say = (text) => pronounceIfcdc(String(text || "").trim());

  // —— Greeting ——
  if (isWelcome || (!session.greeted && (isSilence || !raw))) {
    session.greeted = true;
    let reply;
    if (owner) {
      reply =
        "Welcome back, Mister Allah. This is AURA. How may I assist you with I F C D C Barbers App operations today?";
    } else if (profile?.display_name && session.disclosedProfile) {
      reply = `Welcome back to I F C D C Barbers App. This is AURA. How can I help you today?`;
    } else {
      reply =
        "Thank you for calling I F C D C Barbers App. This is AURA, your shop assistant. I can help with bookings, services, hours, or payment status. How may I help you?";
    }
    await appendTurn(dbQuery, {
      callId,
      callSid,
      intent: "greeting",
      userText: "(welcome)",
      assistantText: reply,
    }).catch(() => {});
    return { handled: true, reply: say(reply), intent: "greeting", callId };
  }

  if (isSilence) {
    const reply = "I'm still here. Please tell me what you need — booking, hours, or something else.";
    return { handled: true, reply: say(reply), intent: "silence", callId };
  }

  // —— Human / escalation ——
  if (intents.primary === "request_human" || intents.all.includes("request_human")) {
    session.humanAsks += 1;
    if (session.humanAsks >= 1) {
      await createEscalation(dbQuery, {
        callId,
        callSid,
        fromE164,
        callerName: profile?.display_name || session.bookingDraft?.name || null,
        reason: "Caller requested a human / administrator",
        actionsAttempted: intents.all,
        recommendedNext: "Owner or admin should return the call",
      }).catch(() => null);
      await finalizeCall(dbQuery, {
        callSid,
        outcome: "escalated",
        summary: "Human requested",
        escalationStatus: "open",
      }).catch(() => {});
      const reply =
        "I understand. I've logged a support summary with your number and reason. A team member will follow up. Is there anything else I can note before we finish?";
      return { handled: true, reply: say(reply), intent: "request_human", callId };
    }
  }

  // —— Owner mode ——
  if (owner) {
    if (/\b(pin|passcode|security)\b/i.test(raw) || (/^\d{4,8}$/.test(raw.replace(/\D/g, "")) && !session.ownerPinOk)) {
      if (ownerPinMatches(raw)) {
        session.ownerPinOk = true;
        const reply = "Owner PIN verified. Sensitive operational actions are unlocked for this call. What would you like next?";
        return { handled: true, reply: say(reply), intent: "owner_pin_ok", callId };
      }
      if (/^\d{4,8}$/.test(raw.replace(/\D/g, ""))) {
        return {
          handled: true,
          reply: say("That PIN was not accepted. Sensitive changes remain locked. You can still ask for today's booking summary."),
          intent: "owner_pin_fail",
          callId,
        };
      }
    }

    if (
      intents.primary === "owner_ops" ||
      intents.primary === "check_appointment_status" ||
      /\b(today|summary|canceled|cancelled|payments?|health|new customers?)\b/i.test(raw)
    ) {
      const summary = await ownerTodaySummary(dbQuery);
      const newCust = await ownerNewCustomerCount(dbQuery, { days: 7 });
      if (!summary) {
        return { handled: true, reply: say(speakUnavailable("today's operations summary")), callId };
      }
      const reply = `Operations summary: ${summary.bookings_today} bookings on the calendar today, ${summary.canceled_today} cancellations today, ${summary.paid_today} marked paid today, and ${newCust == null ? "an unavailable" : newCust} new customer records in the last seven days. Destructive, financial, employee, or configuration changes still need your owner PIN${ownerPinConfigured() ? "" : " once AURA_OWNER_VOICE_PIN is configured"}.`;
      await recordAction(dbQuery, { callSid, kind: "owner_summary", ok: true, payload: summary }).catch(
        () => {},
      );
      return { handled: true, reply: say(reply), intent: "owner_ops", callId };
    }

    if (/\b(delete|refund|fire|password|rotate|disable|wipe)\b/i.test(raw) && !session.ownerPinOk) {
      return {
        handled: true,
        reply: say(
          "That request needs additional verification. Please say or enter your owner PIN first. I will not perform destructive or financial changes without it.",
        ),
        intent: "owner_sensitive_blocked",
        callId,
      };
    }
  }

  // —— Identity gate for private records ——
  const needsIdentity =
    ["reschedule_appointment", "cancel_appointment", "check_appointment_status", "payment_status", "rewards"].includes(
      intents.primary,
    ) || intents.all.some((i) => ["reschedule_appointment", "cancel_appointment", "payment_status"].includes(i));

  if (needsIdentity && fromE164 && profile?.display_name && !session.disclosedProfile) {
    // Soft verify: require caller to confirm name on file before disclosing appointment details
    if (!/\b(yes|it's me|it is me|confirm|this is)\b/i.test(raw)) {
      session._awaitingIdentity = true;
      return {
        handled: true,
        reply: say(
          `For privacy, please confirm you are ${profile.display_name} calling from this number. Say yes to continue, or tell me your full name.`,
        ),
        intent: "identity_challenge",
        callId,
      };
    }
    session.disclosedProfile = true;
    session._awaitingIdentity = false;
  }
  if (session._awaitingIdentity) {
    if (isYes(raw) || (profile?.display_name && raw.toLowerCase().includes(String(profile.display_name).toLowerCase().split(" ")[0] || "___"))) {
      session.disclosedProfile = true;
      session._awaitingIdentity = false;
    } else if (raw.length > 2) {
      session.bookingDraft.name = raw.slice(0, 80);
      session.disclosedProfile = true;
      session._awaitingIdentity = false;
      await touchCallerProfile(dbQuery, fromE164, { displayName: session.bookingDraft.name }).catch(() => {});
    }
  }

  // —— FAQ / live facts ——
  if (intents.primary === "ask_services" || intents.primary === "ask_prices" || intents.primary === "ask_duration") {
    const services = await listPublicServices(dbQuery);
    const line = formatServiceList(services);
    const reply = line || speakUnavailable("services and prices");
    return { handled: true, reply: say(reply), intent: intents.primary, callId };
  }

  if (intents.primary === "find_barber" || intents.primary === "barber_availability") {
    const barbers = await listActiveBarbers(dbQuery);
    const line = formatBarberList(barbers);
    const reply =
      line ||
      speakUnavailable("barber availability") +
        " I can still take a booking for the first available barber if you like.";
    return { handled: true, reply: say(reply), intent: intents.primary, callId };
  }

  if (intents.primary === "ask_hours") {
    const shop = await resolveShopContact(dbQuery);
    const reply = shop
      ? `I have ${shop.name || "I F C D C Barbers"} on file, but live weekly hours are not confirmed in this voice session. Please check the I F C D C Barbers App, or I can help you book and we'll confirm timing with the shop.`
      : speakUnavailable("shop hours");
    return { handled: true, reply: say(reply), intent: "ask_hours", callId };
  }

  if (intents.primary === "ask_location") {
    const shop = await resolveShopContact(dbQuery);
    if (shop && (shop.address || shop.city)) {
      const addr = [shop.address, shop.city, shop.state].filter(Boolean).join(", ");
      return {
        handled: true,
        reply: say(`Our location on file is ${addr}. Would you like help booking an appointment?`),
        intent: "ask_location",
        callId,
      };
    }
    return { handled: true, reply: say(speakUnavailable("the shop address")), intent: "ask_location", callId };
  }

  if (intents.primary === "payment_link") {
    return {
      handled: true,
      reply: say(
        "I never take card numbers by phone. After a booking is created in the app or by our team, you can pay through the secure PayPal checkout link. I can help start a booking, or escalate if a payment already failed.",
      ),
      intent: "payment_link",
      callId,
    };
  }

  if (intents.primary === "payment_status" || intents.primary === "payment_problem") {
    if (!fromE164) {
      return {
        handled: true,
        reply: say("I need your calling number on file to look up payment status. Please call from your booking phone or ask for a team member."),
        callId,
      };
    }
    if (!session.disclosedProfile && profile?.display_name) {
      session._awaitingIdentity = true;
      return {
        handled: true,
        reply: say(`Please confirm you are ${profile.display_name} so I can check payment status securely.`),
        callId,
      };
    }
    const books = await findBookingsByPhone(dbQuery, fromE164, { limit: 1 });
    if (books === null) return { handled: true, reply: say(speakUnavailable("payment status")), callId };
    if (!books.length) {
      return {
        handled: true,
        reply: say("I don't see a recent booking for this number. If you paid under a different phone, I can escalate to support."),
        callId,
      };
    }
    const b = books[0];
    const pay = String(b.payment_status || "unknown").replace(/_/g, " ");
    const ref = String(b.id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
    return {
      handled: true,
      reply: say(
        `Your most recent booking reference ${ref} shows payment status ${pay}. I cannot change charges by voice. For disputes or refunds, I can escalate to an administrator.`,
      ),
      intent: "payment_status",
      callId,
    };
  }

  if (intents.primary === "check_appointment_status" || intents.primary === "reschedule_appointment" || intents.primary === "cancel_appointment") {
    if (!fromE164) {
      return { handled: true, reply: say("Please call from the phone number on your booking so I can locate it securely."), callId };
    }
    const books = await findBookingsByPhone(dbQuery, fromE164, { limit: 3 });
    if (books === null) return { handled: true, reply: say(speakUnavailable("appointment records")), callId };
    if (!books.length) {
      return {
        handled: true,
        reply: say("I couldn't find an appointment for this number. Would you like to book a new one?"),
        callId,
      };
    }
    const b = books[0];
    const ref = String(b.id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
    const when = [b.date, b.time].filter(Boolean).join(" at ");
    const base = `I found booking ${ref}: ${b.service || "appointment"} with ${b.barber_name || "your barber"} on ${when || "the scheduled date"}, status ${String(b.booking_status || "on file").replace(/_/g, " ")}.`;

    if (intents.primary === "check_appointment_status") {
      return { handled: true, reply: say(base + " Would you like to reschedule, cancel, or book another visit?"), callId };
    }
    if (intents.primary === "cancel_appointment") {
      session.bookingDraft.cancelId = b.id;
      session.bookingStep = "confirm_cancel";
      return {
        handled: true,
        reply: say(
          `${base} Cancellation may follow the shop payment policy. Say yes to request cancellation of ${ref}, or no to keep it.`,
        ),
        callId,
      };
    }
    if (intents.primary === "reschedule_appointment") {
      session.bookingDraft.rescheduleId = b.id;
      session.bookingStep = "reschedule_day";
      return {
        handled: true,
        reply: say(`${base} What new day works best? Say today, tomorrow, or a date.`),
        callId,
      };
    }
  }

  if (session.bookingStep === "confirm_cancel") {
    if (isYes(raw)) {
      await createEscalation(dbQuery, {
        callId,
        callSid,
        fromE164,
        callerName: session.bookingDraft.name || profile?.display_name,
        reason: "Voice cancellation requested — requires staff confirmation of policy",
        appointmentRef: session.bookingDraft.cancelId,
        recommendedNext: "Admin review cancel + notify customer",
      }).catch(() => null);
      session.bookingStep = null;
      return {
        handled: true,
        reply: say(
          "I've logged your cancellation request with a confirmation reference for the team. I will not mark it canceled until staff confirms policy. You'll receive email or SMS when available. Anything else?",
        ),
        callId,
      };
    }
    session.bookingStep = null;
    return { handled: true, reply: say("Okay, I left the appointment as is. How else can I help?"), callId };
  }

  if (session.bookingStep === "reschedule_day") {
    const day = parseDay(raw);
    if (!day) {
      return { handled: true, reply: say("Which new day should I request? Say today, tomorrow, or a date."), callId };
    }
    session.bookingDraft.newDate = day;
    session.bookingStep = "reschedule_time";
    return { handled: true, reply: say(`I have ${day}. What new time works?`), callId };
  }

  if (session.bookingStep === "reschedule_time") {
    const tm = parseTime(raw) || raw.slice(0, 32);
    session.bookingDraft.newTime = tm;
    await createEscalation(dbQuery, {
      callId,
      callSid,
      fromE164,
      callerName: session.bookingDraft.name || profile?.display_name,
      reason: `Reschedule requested to ${session.bookingDraft.newDate} ${tm}`,
      appointmentRef: session.bookingDraft.rescheduleId,
      recommendedNext: "Admin confirm slot + send confirmation",
    }).catch(() => null);
    session.bookingStep = null;
    const ref = String(session.bookingDraft.rescheduleId || "")
      .replace(/-/g, "")
      .slice(0, 8)
      .toUpperCase();
    return {
      handled: true,
      reply: say(
        `I've submitted a reschedule request for ${ref} to ${session.bookingDraft.newDate} at ${tm}. You'll get confirmation by email or SMS when the shop confirms the slot. Anything else?`,
      ),
      callId,
    };
  }

  if (intents.primary === "rewards" || intents.primary === "reviews") {
    return {
      handled: true,
      reply: say(
        intents.primary === "rewards"
          ? "Rewards balances are in the I F C D C Barbers App under your profile. I won't invent a points total by voice."
          : "Reviews are collected in the app after completed visits. I can note feedback for the team if you'd like to escalate.",
      ),
      callId,
    };
  }

  if (intents.primary === "general_question") {
    return {
      handled: true,
      reply: say(
        "I F C D C Barbers App is the official booking and shop assistant for Imperial Foundation C D C Barbers. I can book, check status, explain services from live records, or connect you with the team.",
      ),
      callId,
    };
  }

  // —— Multi-intent acknowledgment ——
  if (intents.multi) {
    session.pendingIntents = intents.all.slice(1);
    const reply = `I heard more than one request. Let's start with ${intentSpokenLabel(intents.primary)}. We'll cover the rest after.`;
    // fall through to booking if primary is book
    if (intents.primary !== "book_appointment") {
      await appendTurn(dbQuery, {
        callId,
        callSid,
        intent: intents.primary,
        userText: raw,
        assistantText: reply,
      }).catch(() => {});
      // re-enter single-intent handling by not returning — actually return and let next turn continue
    }
  }

  // —— Smart booking (enhanced) or legacy ——
  if (
    intents.primary === "book_appointment" ||
    session.bookingStep ||
    intents.primary === "confirm_reply"
  ) {
    // Use enhanced draft when intelligence owns booking; else legacy FSM for continuity
    if (!session.bookingStep && intents.primary === "book_appointment") {
      session.bookingStep = "service";
      session.bookingDraft = {
        phone: fromE164,
        barber: profile?.preferred_barber || "first available",
      };
      const reply = profile?.preferred_services
        ? `I can book that. What service would you like today?`
        : `Happy to book you. What service would you like — for example haircut, fade, or beard trim?`;
      return { handled: true, reply: say(reply), intent: "book_appointment", callId };
    }

    if (session.bookingStep === "service") {
      const svc = raw.slice(0, 80);
      if (svc.length < 2) {
        return { handled: true, reply: say("What service should I book?"), callId };
      }
      session.bookingDraft.service = svc;
      session.bookingStep = "barber";
      return {
        handled: true,
        reply: say("Would you like a specific barber, or the first available?"),
        callId,
      };
    }

    if (session.bookingStep === "barber") {
      if (/\bfirst available|any|anyone|no preference\b/i.test(raw)) {
        session.bookingDraft.barber = "first available";
      } else {
        session.bookingDraft.barber = raw.slice(0, 80);
      }
      session.bookingStep = "day";
      return { handled: true, reply: say("What day works best? Say today, tomorrow, or a date."), callId };
    }

    if (session.bookingStep === "day") {
      const day = parseDay(raw);
      if (!day) return { handled: true, reply: say("Which day? Say today, tomorrow, or a date."), callId };
      session.bookingDraft.dateYmd = day;
      session.bookingStep = "time";
      return { handled: true, reply: say(`I have ${day}. What time works for you?`), callId };
    }

    if (session.bookingStep === "time") {
      const tm = parseTime(raw) || raw.slice(0, 40);
      if (!tm) return { handled: true, reply: say("Please tell me a time, like two thirty P M."), callId };
      session.bookingDraft.time = tm;
      session.bookingStep = "name";
      if (profile?.display_name) {
        session.bookingDraft.name = profile.display_name;
        session.bookingStep = "confirm";
        const d = session.bookingDraft;
        return {
          handled: true,
          reply: say(
            `Please confirm: ${d.name}, ${d.service} with ${d.barber} on ${d.dateYmd} at ${d.time}. Price and duration will follow the live service menu. Payment can be completed securely in the app. Say yes to submit this booking, or no to change it.`,
          ),
          callId,
        };
      }
      return { handled: true, reply: say("What name should I put on the appointment?"), callId };
    }

    if (session.bookingStep === "name") {
      const nm = raw.replace(/\s+/g, " ").trim().slice(0, 80);
      if (nm.length < 2) return { handled: true, reply: say("Please say your first and last name."), callId };
      session.bookingDraft.name = nm;
      session.bookingStep = "confirm";
      await touchCallerProfile(dbQuery, fromE164, { displayName: nm }).catch(() => {});
      const d = session.bookingDraft;
      return {
        handled: true,
        reply: say(
          `Please confirm: ${d.name}, ${d.service} with ${d.barber} on ${d.dateYmd} at ${d.time}. Say yes to submit the booking, or no to change it.`,
        ),
        callId,
      };
    }

    if (session.bookingStep === "confirm") {
      if (isNo(raw)) {
        session.bookingStep = "service";
        session.bookingDraft = { phone: fromE164 };
        return { handled: true, reply: say("No problem. Let's start over. What service would you like?"), callId };
      }
      if (!isYes(raw)) {
        return { handled: true, reply: say("Please say yes to submit the booking, or no to change it."), callId };
      }
      if (typeof insertVoiceRow !== "function") {
        session.bookingFails += 1;
        return {
          handled: true,
          reply: say("I couldn't reach the booking system just now. I won't claim this is confirmed. I can escalate to the team or try again."),
          callId,
        };
      }
      const d = session.bookingDraft;
      try {
        const out = await insertVoiceRow({
          channel: "aura_voice",
          name: d.name || "AURA Caller",
          email:
            String(process.env.VOICE_DEFAULT_CUSTOMER_EMAIL || "").trim() ||
            `voice.${String(callSid || "call").slice(-8)}.${Date.now()}@ifcdc-voice.placeholder`,
          phone: fromE164 || null,
          date: d.dateYmd,
          time: parseTime(d.time) || d.time || "14:00",
          barberId: Number(process.env.VOICE_DEFAULT_BARBER_ID || "1") || 1,
          barber: d.barber || "Any barber",
          service: d.service || "Haircut",
          callSid: callSid || `voice_${Date.now()}`,
        });
        if (!out?.ok) throw new Error(out?.message || out?.error || "insert_failed");
        const conf = String(out.bookingId || out.id || "")
          .replace(/-/g, "")
          .slice(0, 8)
          .toUpperCase();
        session.bookingStep = null;
        await recordAction(dbQuery, {
          callSid,
          kind: "booking_created",
          ok: true,
          payload: { confirmation: conf },
        }).catch(() => {});
        await finalizeCall(dbQuery, {
          callSid,
          outcome: "booking_created",
          summary: `Booking ${conf} created via voice intelligence`,
        }).catch(() => {});
        const reply = `You're confirmed. Confirmation ${conf || "is on file"}: ${d.service} with ${d.barber} on ${d.dateYmd} at ${d.time}. A confirmation email will be sent when available. Thank you for choosing I F C D C Barbers App.`;
        return {
          handled: true,
          reply: say(reply),
          afterBookingClose: true,
          hangup: true,
          intent: "book_appointment",
          callId,
        };
      } catch (e) {
        session.bookingFails += 1;
        await recordAction(dbQuery, {
          callSid,
          kind: "booking_failed",
          ok: false,
          payload: { error: String(e?.message || e).slice(0, 160) },
        }).catch(() => {});
        if (session.bookingFails >= 2) {
          await createEscalation(dbQuery, {
            callId,
            callSid,
            fromE164,
            callerName: d.name,
            reason: "Booking failed multiple times on voice",
            recommendedNext: "Admin create booking manually",
          }).catch(() => null);
        }
        return {
          handled: true,
          reply: say(
            "The booking did not complete on our system, so I will not say it is confirmed. I can try again or escalate to the team. What would you prefer?",
          ),
          callId,
        };
      }
    }
  }

  // Default: hand remaining conversational turns to legacy simple booking + OpenAI path
  await appendTurn(dbQuery, {
    callId,
    callSid,
    intent: intents.primary,
    userText: raw,
    assistantText: "(legacy_fallback)",
    action: "use_legacy_booking",
  }).catch(() => {});

  return {
    handled: false,
    useLegacyBooking: true,
    intent: intents.primary,
    callId,
  };
}

module.exports = {
  runVoiceIntelligenceTurn,
  getSession,
  isOwnerCaller,
  pronounceIfcdc,
};
