/**
 * AURA Voice Intelligence Phase 1 orchestrator.
 * Used only when AURA_VOICE_INTELLIGENCE_PHASE_1 is on.
 * Falls through to legacy simple booking when orchestrator returns useLegacyBooking=true.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const {
  isAuraVoiceIntelligencePhase1,
  getOfficialAuraBusinessE164,
} = require("./auraVoiceIntelligenceFlags.cjs");
const {
  FOUNDER_GREETING,
  isFounderCaller,
} = require("./auraFounderIdentity.cjs");
const { recordFounderActivity } = require("./auraFounderAudit.cjs");
const { runFounderCommand, tryFounderPinTurn, detectFounderCommand } = require("./auraFounderCommands.cjs");
const { ensureAuraFounderSchema } = require("./auraFounderMigrations.cjs");
const {
  resolveInboundShopContext,
  resolveShopByCodeOrName,
  buildShopGreeting,
  SHOP_SELECT_PROMPT,
  logShopCallContext,
  listActiveAuraShops,
  loadShopById,
  formatUsDisplay,
} = require("./auraShopContext.cjs");
const { ensureAuraShopTelephonySchema } = require("./auraShopTelephonyMigrations.cjs");
const { ensureAuraShopTenantIsolation } = require("./auraShopTenantIsolationMigrations.cjs");
const { handleFounderShopUpdateTurn, detectShopUpdateIntent } = require("./auraFounderShopUpdates.cjs");
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
const {
  parseSpokenDateToYmd,
  parseSpokenTimeToSlotLabel,
  extractPeriodHint,
  resolveBarber,
  loadServicesForBarber,
  matchService,
  queryAvailability,
  findFirstAvailableAcrossBarbers,
  validateSelectedSlot,
  submitVoiceBooking,
  speakSlotList,
  failFinalizeReply,
  shopTimezone,
  listBookableBarbers,
} = require("./auraVoiceIntelligenceBooking.cjs");

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
      shopId: null,
      shopName: null,
      shopMethod: null,
      needsShopSelection: false,
      platformShared: false,
      shopInactive: false,
    });
  }
  return sessions.get(k);
}

function isOwnerCaller(fromE164) {
  return isFounderCaller(fromE164);
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

  if (owner && typeof dbQuery === "function") {
    await ensureAuraFounderSchema(dbQuery).catch(() => {});
  }
  if (typeof dbQuery === "function") {
    await ensureAuraShopTelephonySchema(dbQuery).catch(() => {});
    await ensureAuraShopTenantIsolation(dbQuery).catch(() => {});
  }

  // Resolve / refresh shop context from Twilio To (dedicated) or shared platform number
  if (!session.shopId && !session.needsShopSelection && !session._shopResolved) {
    const inbound = await resolveInboundShopContext(dbQuery, { to: toE164, from: fromE164 }).catch(() => null);
    session._shopResolved = true;
    if (inbound) {
      session.platformShared = Boolean(inbound.platformShared);
      session.shopMethod = inbound.method || null;
      session.shopInactive = Boolean(inbound.inactive);
      if (inbound.shop && !inbound.needsShopSelection && !inbound.inactive) {
        session.shopId = inbound.shop.shopId;
        session.shopName = inbound.shop.shopName;
        session.needsShopSelection = false;
        session.softShopMatch = Boolean(inbound.softMatch);
        if (inbound.shop.timezone) session.bookingDraft.timezone = inbound.shop.timezone;
      } else if (inbound.needsShopSelection || inbound.inactive) {
        session.needsShopSelection = Boolean(inbound.needsShopSelection);
        session.softShopMatch = Boolean(inbound.softMatch);
        if (inbound.shop) {
          session.shopId = inbound.shop.shopId;
          session.shopName = inbound.shop.shopName;
        }
      }
      await logShopCallContext(dbQuery, {
        callSid,
        fromE164,
        toE164,
        shopId: session.shopId,
        method: session.shopMethod,
        greetingKind: owner ? "founder" : session.shopId ? "shop" : "shared_select",
        detail: { inactive: session.shopInactive, platformShared: session.platformShared },
      }).catch(() => {});
    }
  }

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
      session.ownerVerified = true;
      reply = FOUNDER_GREETING;
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "founder_call_detected",
        ok: true,
        detail: { toE164 },
      }).catch(() => {});
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "founder_identity_verified",
        ok: true,
        detail: { method: "cli_phone", note: "PIN still required for protected actions" },
      }).catch(() => {});
    } else {
      reply = buildShopGreeting({
        shop: session.shopId
          ? { shopName: session.shopName, customGreeting: null }
          : null,
        platformShared: session.platformShared,
        founder: false,
        needsShopSelection: session.needsShopSelection || !session.shopId,
        inactive: session.shopInactive,
      });
      // Prefer live custom greeting when shop known
      if (session.shopId && !session.shopInactive) {
        const live = await loadShopById(dbQuery, session.shopId).catch(() => null);
        if (live) {
          reply = buildShopGreeting({
            shop: live,
            platformShared: session.platformShared,
            needsShopSelection: false,
            inactive: false,
          });
        }
      }
    }
    await appendTurn(dbQuery, {
      callId,
      callSid,
      intent: owner ? "founder_greeting" : "greeting",
      userText: "(welcome)",
      assistantText: reply,
    }).catch(() => {});
    return { handled: true, reply: say(reply), intent: owner ? "founder_greeting" : "greeting", callId };
  }

  if (isSilence) {
    const reply = session.needsShopSelection
      ? SHOP_SELECT_PROMPT
      : "I'm still here. Please tell me what you need — booking, hours, or something else. One question at a time is perfect.";
    return { handled: true, reply: say(reply), intent: "silence", callId };
  }

  // —— Human / escalation (before shop selection so support requests are never swallowed) ——
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

  // —— Shop selection (shared number / unknown shop) ——
  // Only intercept when we still need a shop AND the caller is not mid-booking / mid-founder flow.
  if (
    !owner &&
    !session.bookingStep &&
    (session.needsShopSelection || !session.shopId) &&
    !session.shopInactive &&
    intents.primary !== "request_human"
  ) {
    const picked = await resolveShopByCodeOrName(dbQuery, raw);
    if (picked?.candidates?.length) {
      const names = picked.candidates.map((c) => c.shopName).join(", ");
      return {
        handled: true,
        reply: say(`I found more than one match: ${names}. Please say the full shop name.`),
        intent: "shop_select_ambiguous",
        callId,
      };
    }
    if (picked?.shop) {
      session.shopId = picked.shop.shopId;
      session.shopName = picked.shop.shopName;
      session.shopMethod = picked.method;
      session.needsShopSelection = false;
      if (picked.shop.timezone) session.bookingDraft.timezone = picked.shop.timezone;
      await logShopCallContext(dbQuery, {
        callSid,
        fromE164,
        toE164,
        shopId: session.shopId,
        method: picked.method,
        greetingKind: "shop_selected",
        detail: {},
      }).catch(() => {});
      return {
        handled: true,
        reply: say(
          `Understood — ${picked.shop.shopName}. How may I assist you today?`,
        ),
        intent: "shop_selected",
        callId,
      };
    }
    // Soft history hint: offer confirmation, do not lock tenant yet
    if (session.softShopMatch && session.shopId && session.shopName) {
      if (isYes(raw)) {
        session.needsShopSelection = false;
        session.softShopMatch = false;
        return {
          handled: true,
          reply: say(`Great — continuing with ${session.shopName}. How may I assist you?`),
          intent: "shop_soft_confirmed",
          callId,
        };
      }
      if (/\b(no|different|other|another)\b/i.test(raw)) {
        session.shopId = null;
        session.shopName = null;
        session.softShopMatch = false;
        return { handled: true, reply: say(SHOP_SELECT_PROMPT), intent: "shop_select_required", callId };
      }
    }
    // Only force the shop question for shared/unknown routing — not for every utterance
    if (
      (session.needsShopSelection || session.platformShared) &&
      !session.shopId &&
      (intents.primary === "book_appointment" ||
        intents.primary === "ask_hours" ||
        intents.primary === "ask_prices" ||
        intents.primary === "ask_services" ||
        intents.primary === "barber_availability" ||
        /\b(shop|location|where)\b/i.test(raw))
    ) {
      return {
        handled: true,
        reply: say(SHOP_SELECT_PROMPT),
        intent: "shop_select_required",
        callId,
      };
    }
  }

  // —— Founder Command Mode (CLI +18484694448 only) ——
  if (owner) {
    // Active shop-info update FSM takes priority
    if (session.infoUpdate?.step) {
      const upd = await handleFounderShopUpdateTurn({
        dbQuery,
        callSid,
        fromE164,
        raw,
        session,
      });
      if (upd?.handled) {
        return { ...upd, reply: say(upd.reply), callId };
      }
    }

    const pinTurn = tryFounderPinTurn(session, raw, { callSid, fromE164, dbQuery });
    if (pinTurn?.handled) {
      if (pinTurn.resumeProtected && session.ownerPinOk) {
        const resumed = await runFounderCommand({
          dbQuery,
          callSid,
          fromE164,
          raw: session.pendingProtectedRaw || raw,
          session,
          insertVoiceRow,
        });
        session.pendingProtectedCmd = null;
        session.pendingProtectedRaw = null;
        if (resumed?.handled) {
          return { ...resumed, reply: say(resumed.reply), callId };
        }
      }
      return { ...pinTurn, reply: say(pinTurn.reply), callId };
    }

    const founderCmd = detectFounderCommand(raw);
    // Founder multi-shop context switches
    if (/\b(switch to|go to|open)\b.+\bshop\b/i.test(raw) || /\bfor (the )?.+ shop\b/i.test(raw)) {
      const picked = await resolveShopByCodeOrName(dbQuery, raw.replace(/\b(switch to|go to|open|for)\b/gi, " ").trim());
      if (picked?.shop) {
        session.shopId = picked.shop.shopId;
        session.shopName = picked.shop.shopName;
        session.needsShopSelection = false;
        await logShopCallContext(dbQuery, {
          callSid,
          fromE164,
          toE164,
          shopId: session.shopId,
          method: "founder_switch_shop",
          greetingKind: "founder_shop_context",
          detail: {},
        }).catch(() => {});
        return {
          handled: true,
          reply: say(
            `Switched to ${picked.shop.shopName}. Phone on file is ${picked.shop.publicPhoneDisplay || "not set"}. What would you like for this shop?`,
          ),
          intent: "founder_switch_shop",
          callId,
        };
      }
    }
    if (/\b(every shop|all shops|platform-wide|updates for every shop)\b/i.test(raw)) {
      const shops = await listActiveAuraShops(dbQuery, { limit: 12 });
      if (!shops) {
        return { handled: true, reply: say("I could not load the shop roster from live records."), callId };
      }
      const names = shops.map((s) => s.shopName).join(", ");
      return {
        handled: true,
        reply: say(
          `Platform-wide: ${shops.length} active AURA-enabled shops on record${names ? `: ${names}` : ""}. Say switch to a shop name for shop-specific details.`,
        ),
        intent: "founder_all_shops",
        callId,
      };
    }
    if (/\b(that shop'?s?|this shop'?s?|shop'?s?) phone\b/i.test(raw) && session.shopId) {
      const live = await loadShopById(dbQuery, session.shopId);
      return {
        handled: true,
        reply: say(
          live?.publicPhoneDisplay || live?.publicPhoneE164
            ? `${live.shopName} public phone is ${live.publicPhoneDisplay || live.publicPhoneE164}.`
            : "That shop does not have a public phone on file yet.",
        ),
        intent: "founder_shop_phone",
        callId,
      };
    }

    // Spoken shop information updates (PIN + confirm + audit)
    if (detectShopUpdateIntent(raw) || session.infoUpdate) {
      const upd = await handleFounderShopUpdateTurn({
        dbQuery,
        callSid,
        fromE164,
        raw,
        session,
      });
      if (upd?.handled) {
        return { ...upd, reply: say(upd.reply), callId };
      }
    }

    if (founderCmd.cmd) {
      const out = await runFounderCommand({
        dbQuery,
        callSid,
        fromE164,
        raw,
        session,
        insertVoiceRow,
      });
      if (out?.handled) {
        if (out.continueCustomerBooking) {
          // Fall through into booking FSM below with founder-assisted draft.
        } else {
          await appendTurn(dbQuery, {
            callId,
            callSid,
            intent: out.intent,
            userText: raw,
            assistantText: out.reply,
          }).catch(() => {});
          return { ...out, reply: say(out.reply), callId };
        }
      }
    }

    if (
      /\b(delete|refund|fire|password|rotate|disable|wipe|staff|settings?)\b/i.test(raw) &&
      !session.ownerPinOk
    ) {
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "protected_action_requested",
        ok: false,
        detail: { denied: "pin_required", hint: "sensitive_keyword" },
      }).catch(() => {});
      return {
        handled: true,
        reply: say(
          "That request needs additional verification. Please say or enter your founder PIN first. I will not perform destructive, financial, staff, or configuration changes without it.",
        ),
        intent: "founder_sensitive_blocked",
        callId,
      };
    }

    // Legacy owner ops phrases still map to executive brief
    if (
      intents.primary === "owner_ops" ||
      /\b(today'?s (bookings?|summary)|system health|operations|new customers?)\b/i.test(raw)
    ) {
      const out = await runFounderCommand({
        dbQuery,
        callSid,
        fromE164,
        raw: "give me today's full schedule",
        session,
        insertVoiceRow,
      });
      if (out?.handled) {
        return { ...out, reply: say(out.reply), callId };
      }
    }
  } else {
    // Unknown callers cannot update shop information
    if (detectShopUpdateIntent(raw)) {
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "protected_action_requested",
        ok: false,
        detail: { denied: "not_founder", field: detectShopUpdateIntent(raw)?.field },
      }).catch(() => {});
      return {
        handled: true,
        reply: say(
          "I cannot change shop information from this number. Only the verified Founder can update shop settings after PIN verification.",
        ),
        intent: "shop_update_unauthorized",
        callId,
      };
    }
    const deniedCmd = detectFounderCommand(raw);
    const founderOnly =
      deniedCmd.cmd &&
      ![
        // These phrases can also be customer booking language — do not hard-deny.
      ].includes(deniedCmd.cmd) &&
      (/\b(founder mode|founder command|as (the )?founder)\b/i.test(raw) ||
        [
          "changes_since_last_call",
          "who_booked_today",
          "cancellations_today",
          "reschedules_today",
          "busiest_barber",
          "customer_problems",
          "open_slots",
          "executive_brief",
          "book_for_me",
        ].includes(deniedCmd.cmd));
    if (founderOnly) {
      return {
        handled: true,
        reply: say(
          "Founder Command Mode is only available from the verified founder line. I can still help with bookings, services, hours, or payment status.",
        ),
        intent: "founder_mode_denied",
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

  // —— FAQ / live facts (shop-scoped; fail closed without shop) ——
  if (intents.primary === "ask_services" || intents.primary === "ask_prices" || intents.primary === "ask_duration") {
    if (!session.shopId) {
      return {
        handled: true,
        reply: say("Please tell me which shop you're calling about first, then I can share services and prices."),
        intent: intents.primary,
        callId,
      };
    }
    const services = await listPublicServices(dbQuery, { shopId: session.shopId });
    const line = formatServiceList(services);
    const reply = line || speakUnavailable("services and prices");
    return { handled: true, reply: say(reply), intent: intents.primary, callId };
  }

  if (intents.primary === "find_barber" || intents.primary === "barber_availability") {
    if (!session.shopId) {
      return {
        handled: true,
        reply: say("Please tell me which shop you're calling about first, then I can list barbers."),
        intent: intents.primary,
        callId,
      };
    }
    const barbers = await listActiveBarbers(dbQuery, { shopId: session.shopId });
    const line = formatBarberList(barbers);
    const reply =
      line ||
      speakUnavailable("barber availability") +
        " I can still take a booking for the first available barber if you like.";
    return { handled: true, reply: say(reply), intent: intents.primary, callId };
  }

  if (intents.primary === "ask_hours") {
    if (!session.shopId) {
      return {
        handled: true,
        reply: say("Please tell me which shop you're calling about first."),
        intent: "ask_hours",
        callId,
      };
    }
    const shop = await resolveShopContact(dbQuery, { shopId: session.shopId });
    const hoursNote =
      shop?.operating_hours_json?.note ||
      (typeof shop?.operating_hours_json === "object" && shop?.operating_hours_json?.summary) ||
      null;
    if (hoursNote) {
      return {
        handled: true,
        reply: say(`${shop.name || "This shop"} hours on file are ${hoursNote}. Would you like to book?`),
        intent: "ask_hours",
        callId,
      };
    }
    const reply = shop
      ? `I have ${shop.name || "the shop"} on file, but live weekly hours are not confirmed in this voice session. I can help you book and we'll confirm timing with the shop.`
      : speakUnavailable("shop hours");
    return { handled: true, reply: say(reply), intent: "ask_hours", callId };
  }

  if (intents.primary === "ask_location") {
    if (!session.shopId) {
      return {
        handled: true,
        reply: say("Please tell me which shop you're calling about first."),
        intent: "ask_location",
        callId,
      };
    }
    const shop = await resolveShopContact(dbQuery, { shopId: session.shopId });
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
  if (intents.multi && intents.primary !== "book_appointment") {
    session.pendingIntents = intents.all.slice(1);
    const reply = `I heard more than one request. Let's start with ${intentSpokenLabel(intents.primary)}. We'll cover the rest after.`;
    await appendTurn(dbQuery, {
      callId,
      callSid,
      intent: intents.primary,
      userText: raw,
      assistantText: reply,
    }).catch(() => {});
  }

  // —— Production booking (barberSlotEngine + insertAuraVoiceBookingRow) ——
  if (
    intents.primary === "book_appointment" ||
    session.bookingStep ||
    (intents.primary === "confirm_reply" && session.bookingStep)
  ) {
    const draft = session.bookingDraft || (session.bookingDraft = { phone: fromE164 });

    if (!session.shopId) {
      return {
        handled: true,
        reply: say(SHOP_SELECT_PROMPT),
        intent: "shop_select_required",
        callId,
      };
    }
    draft.shopId = session.shopId;
    draft.shopName = session.shopName;

    if (!session.bookingStep && intents.primary === "book_appointment") {
      session.bookingStep = "service";
      draft.phone = fromE164;
      draft.timezone = draft.timezone || shopTimezone();
      return {
        handled: true,
        reply: say(
          `I can book at ${session.shopName} using live availability. What service would you like — for example Regular Haircut, Fade, or Beard Trim?`,
        ),
        intent: "book_appointment",
        callId,
      };
    }

    if (session.bookingStep === "service") {
      draft.serviceSpoken = raw.slice(0, 80);
      session.bookingStep = "barber";
      return {
        handled: true,
        reply: say("Would you like a specific barber, or the first available?"),
        callId,
      };
    }

    if (session.bookingStep === "barber") {
      const firstAvail = /\bfirst available|any|anyone|no preference\b/i.test(raw);
      const resolved = await resolveBarber(dbQuery, {
        barberName: firstAvail ? "first available" : raw.slice(0, 80),
        firstAvailable: firstAvail,
        shopId: session.shopId,
      });
      if (!resolved.ok) {
        return {
          handled: true,
          reply: say(
            resolved.error === "no_barbers"
              ? "I cannot confirm an active barber in live records right now. I have not booked anything."
              : "I couldn't match that barber. Please say a barber name, or say first available.",
          ),
          callId,
        };
      }
      draft.barberId = resolved.barberId;
      draft.barberName = resolved.barberName;
      draft.firstAvailable = Boolean(resolved.firstAvailable);

      const services = await loadServicesForBarber(dbQuery, {
        barberId: draft.barberId,
        barberName: draft.barberName,
      });
      if (services === null) {
        return { handled: true, reply: say(failFinalizeReply()), callId };
      }
      const matched = matchService(services, draft.serviceSpoken);
      if (!matched) {
        const names = services
          .slice(0, 5)
          .map((s) => s.name || s.title)
          .filter(Boolean);
        session.bookingStep = "service";
        return {
          handled: true,
          reply: say(
            names.length
              ? `I couldn't match that service for ${draft.barberName}. Please choose one of: ${names.join(", ")}.`
              : `I don't have active services on file for ${draft.barberName} right now.`,
          ),
          callId,
        };
      }
      draft.serviceName = String(matched.name || matched.title).trim();
      draft.serviceId = matched.id || null;
      draft.durationMinutes = Number(matched.duration_minutes) || 30;
      draft.price = Number(matched.price) || null;
      session.bookingStep = "day";
      return {
        handled: true,
        reply: say(
          `Got it — ${draft.serviceName} with ${draft.barberName}, about ${draft.durationMinutes} minutes${draft.price != null ? ` at ${draft.price} dollars` : ""}. What day works? Say today, tomorrow, Friday, or a date.`,
        ),
        callId,
      };
    }

    if (session.bookingStep === "day") {
      const ymd = await parseSpokenDateToYmd(raw, draft.timezone || shopTimezone());
      if (!ymd) {
        return {
          handled: true,
          reply: say("Which day? For example tomorrow afternoon, Friday, or next Saturday."),
          callId,
        };
      }
      draft.dateYmd = ymd;
      draft.periodHint = extractPeriodHint(raw);

      // If first-available was requested, search across barbers for this day
      if (draft.firstAvailable) {
        const found = await findFirstAvailableAcrossBarbers(dbQuery, {
          dateYmd: ymd,
          durationMinutes: draft.durationMinutes || 30,
          serviceName: draft.serviceSpoken || draft.serviceName,
          shopId: session.shopId,
        });
        if (!found.ok) {
          return {
            handled: true,
            reply: say(
              `I don't have open times on ${ymd} in live availability. Please try another day. I have not booked anything.`,
            ),
            callId,
          };
        }
        draft.barberId = found.barberId;
        draft.barberName = found.barberName;
        draft.openSlots = found.openSlots;
        draft.timezone = found.timezone || draft.timezone;
      } else {
        const avail = await queryAvailability(dbQuery, {
          barberId: draft.barberId,
          barberName: draft.barberName,
          dateYmd: ymd,
          durationMinutes: draft.durationMinutes || 30,
        });
        if (!avail.ok) {
          return { handled: true, reply: say(failFinalizeReply()), callId };
        }
        if (!avail.openSlots.length) {
          return {
            handled: true,
            reply: say(
              `I don't have open times with ${draft.barberName} on ${ymd}. Please choose another day. I have not booked anything.`,
            ),
            callId,
          };
        }
        draft.openSlots = avail.openSlots;
        draft.timezone = avail.timezone || draft.timezone;
      }

      // Combined date+time utterance e.g. "Friday at 2:30"
      const spokenTime = await parseSpokenTimeToSlotLabel(raw, { periodHint: draft.periodHint });
      if (spokenTime && draft.openSlots.includes(spokenTime)) {
        draft.timeLabel = spokenTime;
        if (profile?.display_name) {
          draft.name = profile.display_name;
          session.bookingStep = "confirm";
          const priceBit =
            draft.price != null && Number.isFinite(Number(draft.price))
              ? `${draft.price} dollars`
              : "the live menu price";
          return {
            handled: true,
            reply: say(
              `Please confirm: ${draft.name}, ${draft.serviceName} with ${draft.barberName} at ${draft.shopName || session.shopName} on ${draft.dateYmd} at ${draft.timeLabel}, about ${draft.durationMinutes} minutes, ${priceBit}. Say yes to submit, or no to change it.`,
            ),
            callId,
          };
        }
        session.bookingStep = "name";
        return {
          handled: true,
          reply: say(`I can hold ${spokenTime} on ${ymd}. What name should I put on the appointment?`),
          callId,
        };
      }
      if (spokenTime && !draft.openSlots.includes(spokenTime)) {
        session.bookingStep = "time";
        return {
          handled: true,
          reply: say(
            `${spokenTime} is not open on ${ymd}. ${speakSlotList(draft.openSlots)} Which time would you like?`,
          ),
          callId,
        };
      }
      session.bookingStep = "time";
      return {
        handled: true,
        reply: say(
          `For ${ymd} with ${draft.barberName}, ${speakSlotList(draft.openSlots)} Which time works?`,
        ),
        callId,
      };
    }

    if (session.bookingStep === "time") {
      const timeLabel = await parseSpokenTimeToSlotLabel(raw, {
        periodHint: extractPeriodHint(raw) || draft.periodHint,
      });
      if (!timeLabel) {
        return {
          handled: true,
          reply: say(`Please say a time like two thirty P M. ${speakSlotList(draft.openSlots || [])}`),
          callId,
        };
      }
      if (Array.isArray(draft.openSlots) && draft.openSlots.length && !draft.openSlots.includes(timeLabel)) {
        return {
          handled: true,
          reply: say(
            `${timeLabel} is not available. ${speakSlotList(draft.openSlots)} Please choose one of those times.`,
          ),
          callId,
        };
      }
      const pre = await validateSelectedSlot({
        barberId: draft.barberId,
        barberName: draft.barberName,
        dateYmd: draft.dateYmd,
        timeLabel,
        durationMinutes: draft.durationMinutes || 30,
      });
      if (!pre.ok) {
        return {
          handled: true,
          reply: say(
            `${pre.message || "That time is not available."} ${speakSlotList(draft.openSlots || [])} I have not booked anything.`,
          ),
          callId,
        };
      }
      draft.timeLabel = timeLabel;
      if (profile?.display_name) {
        draft.name = profile.display_name;
        session.bookingStep = "confirm";
        const priceBit =
          draft.price != null && Number.isFinite(Number(draft.price))
            ? `${draft.price} dollars`
            : "the live menu price";
        return {
          handled: true,
          reply: say(
            `Please confirm: ${draft.name}, ${draft.serviceName} with ${draft.barberName} at ${draft.shopName || session.shopName} on ${draft.dateYmd} at ${draft.timeLabel}, about ${draft.durationMinutes} minutes, ${priceBit}. Payment is pay in person unless you complete checkout in the app. Say yes to submit this booking, or no to change it.`,
          ),
          callId,
        };
      }
      session.bookingStep = "name";
      return {
        handled: true,
        reply: say("What name should I put on the appointment?"),
        callId,
      };
    }

    if (session.bookingStep === "name") {
      const nm = raw.replace(/\s+/g, " ").trim().slice(0, 80);
      const digits = nm.replace(/\D/g, "");
      if (nm.length < 2 || (digits.length >= 10 && !/[a-z]{2,}/i.test(nm))) {
        return {
          handled: true,
          reply: say("What name should I put on the appointment? Please say your first and last name."),
          callId,
        };
      }
      draft.name = nm;
      await touchCallerProfile(dbQuery, fromE164, { displayName: nm }).catch(() => {});
      session.bookingStep = "confirm";
      const priceBit =
        draft.price != null && Number.isFinite(Number(draft.price))
          ? `${draft.price} dollars`
          : "the live menu price";
      return {
        handled: true,
        reply: say(
          `Please confirm: ${draft.name}, ${draft.serviceName} with ${draft.barberName} at ${draft.shopName || session.shopName} on ${draft.dateYmd} at ${draft.timeLabel}, about ${draft.durationMinutes} minutes, ${priceBit}. Payment is pay in person unless you complete checkout in the app. Say yes to submit this booking, or no to change it.`,
        ),
        callId,
      };
    }

    if (session.bookingStep === "confirm") {
      if (isNo(raw)) {
        session.bookingStep = "service";
        session.bookingDraft = { phone: fromE164, timezone: shopTimezone() };
        return {
          handled: true,
          reply: say("Okay, let's start over. What service would you like?"),
          callId,
        };
      }
      if (!isYes(raw)) {
        return {
          handled: true,
          reply: say("Please say yes to submit the booking, or no to change it."),
          callId,
        };
      }
      if (typeof insertVoiceRow !== "function") {
        session.bookingFails += 1;
        return { handled: true, reply: say(failFinalizeReply()), callId };
      }

      let pre;
      try {
        pre = await validateSelectedSlot({
          barberId: draft.barberId,
          barberName: draft.barberName,
          dateYmd: draft.dateYmd,
          timeLabel: draft.timeLabel,
          durationMinutes: draft.durationMinutes || 30,
        });
      } catch (e) {
        session.bookingFails += 1;
        console.warn("[aura-voice-intel] pre-confirm validate failed:", e?.message || e);
        return { handled: true, reply: say(failFinalizeReply()), callId };
      }
      if (!pre.ok) {
        session.bookingFails += 1;
        return {
          handled: true,
          reply: say(`${failFinalizeReply()} ${pre.message || ""}`.trim()),
          callId,
        };
      }

      const out = await submitVoiceBooking(insertVoiceRow, {
        channel: "aura_voice",
        name: draft.name || "AURA Caller",
        email:
          String(process.env.VOICE_DEFAULT_CUSTOMER_EMAIL || "").trim() ||
          `voice.${String(callSid || "call").slice(-8)}.${Date.now()}@ifcdc-voice.placeholder`,
        phone: fromE164 || null,
        date: draft.dateYmd,
        time: draft.timeLabel,
        barberId: draft.barberId,
        barber: draft.barberName,
        service: draft.serviceName,
        price: draft.price != null ? Number(draft.price) : undefined,
        callSid: callSid || `voice_${Date.now()}`,
        durationMinutes: draft.durationMinutes || 30,
        businessId: draft.shopId || session.shopId,
        shopId: draft.shopId || session.shopId,
        shopName: draft.shopName || session.shopName,
        timezone: draft.timezone || shopTimezone(),
        bookingSource: "aura_voice",
      });

      if (!out?.ok || !out.booking?.id) {
        session.bookingFails += 1;
        await recordAction(dbQuery, {
          callSid,
          kind: "booking_failed",
          ok: false,
          payload: { error: out?.error || "no_booking_id" },
        }).catch(() => {});
        if (session.bookingFails >= 2) {
          await createEscalation(dbQuery, {
            callId,
            callSid,
            fromE164,
            callerName: draft.name,
            reason: "Voice booking failed after live slot validation",
            recommendedNext: "Admin create booking manually",
          }).catch(() => null);
        }
        return { handled: true, reply: say(failFinalizeReply()), callId };
      }

      const bookingId = out.booking.id;
      const conf = String(bookingId).replace(/-/g, "").slice(0, 8).toUpperCase();
      session.bookingStep = null;
      await recordAction(dbQuery, {
        callSid,
        kind: "booking_created",
        ok: true,
        payload: { confirmation: conf, bookingId },
      }).catch(() => {});
      await finalizeCall(dbQuery, {
        callSid,
        outcome: "booking_created",
        summary: `Booking ${conf} created via voice intelligence`,
      }).catch(() => {});
      return {
        handled: true,
        reply: say(
          `You're confirmed. Confirmation ${conf}: ${draft.serviceName} with ${draft.barberName} on ${draft.dateYmd} at ${draft.timeLabel}, about ${draft.durationMinutes} minutes. A confirmation email will be sent when available. Thank you for choosing I F C D C Barbers App.`,
        ),
        afterBookingClose: true,
        hangup: true,
        intent: "book_appointment",
        callId,
      };
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
  isFounderCaller,
  pronounceIfcdc,
};
