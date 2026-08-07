/**
 * Strict step-by-step voice booking for simple AURA (non-wizard).
 * One state advance per valid utterance — no AI step-skipping.
 */

import { ack } from "./auraVoiceAck.js";

export const STATES = {
  START: "start",
  SERVICE: "service",
  DAY: "day",
  TIME: "time",
  NAME: "name",
  CONFIRM: "confirm",
  /** After booking: “anything else?” then graceful hangup. */
  ANYTHING_ELSE: "anything_else",
  /** Terminal — call should have ended. */
  END: "end",
  /** @deprecated use ANYTHING_ELSE */
  DONE: "anything_else",
};

const MAX_SESSIONS = 2000;

/** @type {Record<string, { step: string, data: Record<string, string>, completed: boolean }>} */
const callState = Object.create(null);

function pruneCallState() {
  while (Object.keys(callState).length > MAX_SESSIONS) {
    const k = Object.keys(callState)[0];
    if (k === undefined) break;
    delete callState[k];
  }
}

/**
 * @param {string} callSid
 * @returns {{ step: string, data: Record<string, string> } | null}
 */
function getState(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return null;
  pruneCallState();
  if (!callState[k]) {
    callState[k] = { step: STATES.START, data: {}, completed: false };
  }
  return callState[k];
}

export function resetSimpleBookingState(callSid) {
  const k = String(callSid || "").trim();
  if (k) delete callState[k];
}

/** For Twilio `/process`: treat empty user input as silence during closing, not welcome “hello”. */
export function getSimpleBookingStage(callSid) {
  const s = getState(callSid);
  return s ? String(s.step) : null;
}

function ymdTomorrow() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ymdToday() {
  const t = new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDayFromSpeech(raw) {
  const s = String(raw || "").toLowerCase();
  if (/\btomorrow\b/.test(s)) return ymdTomorrow();
  if (/\btoday\b/.test(s)) return ymdToday();
  const iso = String(raw || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  return "";
}

function parseTimeFromSpeech(raw) {
  const lower = String(raw || "").toLowerCase();
  if (/\b(morning|early)\b/.test(lower) && !/\b(afternoon|evening)\b/.test(lower)) return "10:00";
  if (/\b(afternoon|after lunch)\b/.test(lower)) return "14:00";
  if (/\b(evening|after work)\b/.test(lower)) return "17:00";
  const ampm = String(raw || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const mi = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const ap = String(ampm[3]).toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  const t24 = String(raw || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) return `${String(t24[1]).padStart(2, "0")}:${t24[2]}`;
  return "";
}

/** Lowercase trim; strip trailing STT punctuation without loosening yes/no to substring rules. */
function normalizeConfirmInput(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[.!?,;:…]+$/gu, "");
}

function isYes(text) {
  return /\b(yes|yeah|yep|correct|right|si|sí|claro|vale|correcto)\b/i.test(text);
}

function isNo(text) {
  return /\b(no|nope|nah)\b/i.test(text);
}

/** User is done (matches "no", "that's it", "all set", etc.). */
function wantsToEndClosing(text) {
  const s = String(text || "").toLowerCase().trim();
  if (!s) return false;
  return /\b(that'?s it|that is it|that'?s all|that is all|nothing else|no thanks|no thank you|i'?m good|we'?re good|all set|i'?m all set|we'?re all set|that will be all|we'?re done|i'?m done)\b/i.test(
    s,
  );
}

/**
 * Single exit for post-booking voice close (lines before Gather).
 * @param {object} opts
 * @param {(en: string, es: string) => string} T
 */
function endCall(opts, T) {
  console.log("📞 USING FINAL CLOSING FLOW");
  console.log("📧 EMAIL CONFIRMATION FLOW ACTIVE");
  const confirmLine = T(
    "You're all set. Your appointment has been confirmed. Thank you for choosing IFCDC.",
    "Todo listo. Tu cita está confirmada. Gracias por elegir IFCDC.",
  );
  return {
    reply: confirmLine,
    afterBookingClose: true,
  };
}

function inferService(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (/\b(fade|taper|lineup|buzz)\b/.test(lower)) return t.slice(0, 80);
  if (/\b(beard|mustache)\b/.test(lower)) return "Beard trim";
  if (/\b(haircut|cut|trim)\b/.test(lower)) return "Haircut";
  return t.replace(/\s+/g, " ").slice(0, 80);
}

function looksLikePhoneOnly(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 10 && !/[a-z]{2,}/i.test(String(s || ""));
}

function tenDigitsFromE164(e164) {
  const d = String(e164 || "").replace(/\D/g, "");
  return d.slice(-10) || "caller";
}

/**
 * @param {Record<string, string>} data
 * @param {string} callSid
 * @param {(b: object) => Promise<object>} insertVoiceRow
 */
async function saveBooking(data, callSid, insertVoiceRow) {
  const barberId = Number(process.env.VOICE_DEFAULT_BARBER_ID || "1") || 1;
  const timeHHmm = parseTimeFromSpeech(String(data.time || "")) || "14:00";
  const guestEmail =
    String(process.env.VOICE_DEFAULT_CUSTOMER_EMAIL || "").trim() ||
    `voice.${String(callSid || "call").slice(-8)}.${Date.now()}@ifcdc-voice.placeholder`;
  const bookBody = {
    channel: "aura_voice",
    name: String(data.name || "AURA Caller").trim() || "AURA Caller",
    email: guestEmail,
    phone: null,
    date: data.dateYmd,
    time: timeHHmm,
    barberId,
    barber: "Any barber",
    service: String(data.service || "Haircut").trim() || "Haircut",
    callSid: callSid || `voice_${Date.now()}`,
  };
  const out = await insertVoiceRow(bookBody);
  if (!out?.ok) {
    throw new Error(String(out?.message || out?.error || "insert_not_ok"));
  }
  return out;
}

/**
 * @param {string} callSid
 * @param {string} input
 * @param {string} language
 * @param {((b: object) => Promise<object>) | undefined} insertVoiceRow
 * @returns {Promise<{ reply: string; log: string; afterBookingClose?: boolean; duplicateExecutionBlocked?: boolean; hangupFollowup?: boolean }>}
 */
async function handleBooking(callSid, input, language, insertVoiceRow) {
  const L = String(language || "en").toLowerCase().startsWith("es") ? "es" : "en";
  const T = (en, es) => (L === "es" ? es : en);

  const session = getState(callSid);
  if (!session) {
    return {
      reply: T("What service would you like today?", "¿Qué servicio deseas hoy?"),
      log: "MISSING_CALLSID",
    };
  }

  const d = session.data;
  const trimmed = String(input || "").trim();
  const empty = !trimmed || input === "no_input" || trimmed === "no_input";
  if (empty && session.step === STATES.SERVICE) {
    return {
      reply: T(
        "I'm here with you. What service would you like today?",
        "Estoy contigo. ¿Qué servicio te gustaría hoy?",
      ),
      log: "empty_input_service",
    };
  }

  switch (session.step) {
    case STATES.START: {
      session.step = STATES.SERVICE;
      return {
        reply: T(
          "Thank you for calling the IFCDC Barbers App. This is AURA, your virtual assistant. I'm here to help you schedule appointments, answer questions, and assist with our services. How may I help you today?",
          "Gracias por llamar a la aplicación IFCDC Barbers. Soy AURA, tu asistente virtual. Estoy aquí para ayudarte a agendar citas, responder preguntas y asistirte con nuestros servicios. ¿En qué puedo ayudarte hoy?",
        ),
        log: "start→service",
      };
    }
    case STATES.SERVICE: {
      const svc = inferService(input);
      if (!svc) {
        return {
          reply: T(
            "What service should I book? For example, say haircut, fade, or beard trim.",
            "¿Qué servicio reservo? Por ejemplo, di corte, fade o barba.",
          ),
          log: "service_reprompt",
        };
      }
      d.service = svc;
      session.step = STATES.DAY;
      {
        const a = ack(callSid, L);
        return {
          reply: T(
            `${a} ${d.service}. What day works best? Say today, tomorrow, or a date.`,
            `${a} ${d.service}. ¿Qué día te viene bien? Di hoy, mañana, o una fecha.`,
          ),
          log: "service→day",
        };
      }
    }
    case STATES.DAY: {
      const dateYmd = parseDayFromSpeech(input);
      if (!dateYmd) {
        return {
          reply: T(
            "Which day would you like? Say today, tomorrow, or a calendar date.",
            "¿Qué día quieres? Di hoy, mañana, o una fecha.",
          ),
          log: "day_reprompt",
        };
      }
      d.dateYmd = dateYmd;
      d.day = dateYmd;
      d.dayLabel = String(input || "").trim().slice(0, 80);
      session.step = STATES.TIME;
      return {
        reply: T(
          `I have ${d.dateYmd}. What time would you like? Say morning, afternoon, or a time like two thirty P M.`,
          `Tengo el ${d.dateYmd}. ¿Qué hora quieres? Di mañana, tarde, o una hora.`,
        ),
        log: "day→time",
      };
    }
    case STATES.TIME: {
      if (!trimmed || trimmed.length < 2) {
        return {
          reply: T("Please tell me a valid time.", "Por favor dime una hora válida."),
          log: "time_reprompt_short",
        };
      }
      d.time = trimmed.slice(0, 120);
      session.step = STATES.NAME;
      return {
        reply: T(
          "Can I get your name for the appointment?",
          "¿Cuál es tu nombre para la cita?",
        ),
        log: "time→name",
      };
    }
    case STATES.NAME: {
      const nm = String(input || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (!nm || looksLikePhoneOnly(nm)) {
        return {
          reply: T(
            "What name should I put on the booking? Say your first and last name.",
            "¿Qué nombre pongo en la reserva? Di tu nombre.",
          ),
          log: "name_reprompt",
        };
      }
      d.name = nm;
      session.step = STATES.CONFIRM;
      {
        const a = ack(callSid, L);
        const timeDisplay = d.time || parseTimeFromSpeech(d.time) || "";
        return {
          reply: T(
            `${a} Just to confirm, ${d.name}, you want a ${d.service} on ${d.dateYmd} at ${timeDisplay}. Please say yes to confirm your booking or no to change it.`,
            `${a} Confirmo: ${d.name}, ${d.service} el ${d.dateYmd} a las ${timeDisplay}. Di sí para confirmar la reserva o no para cambiarla.`,
          ),
          log: "name→confirm",
        };
      }
    }
    case STATES.CONFIRM: {
      const normalized = normalizeConfirmInput(input);
      if (isYes(normalized)) {
        if (session.completed) {
          console.log("⚠️ Duplicate execution blocked");
          return {
            reply: "",
            log: "duplicate_execution_blocked",
            duplicateExecutionBlocked: true,
          };
        }
        if (
          !session.data.service ||
          !session.data.day ||
          !session.data.time ||
          !session.data.name
        ) {
          return {
            reply: T(
              "I need to confirm all your details first. Please say no to make changes.",
              "Necesito confirmar todos tus datos primero. Di no para hacer cambios.",
            ),
            log: "confirm_missing_core_fields",
          };
        }
        if (typeof insertVoiceRow !== "function") {
          return {
            reply: T(
              "I can't save bookings on this server yet. Please call the shop to finish. Say no to change your details.",
              "Aún no puedo guardar aquí. Llama a la barbería. Di no para cambiar tus datos.",
            ),
            log: "save_skipped_no_insertVoiceRow",
          };
        }
        try {
          await saveBooking(d, callSid, insertVoiceRow);
          console.log("BOOKING SAVED:", { ...d, callSid });
        } catch (err) {
          console.error("SAVE FAILED:", err?.stack || err);
          return {
            reply: T(
              "Please say yes again to confirm your booking.",
              "Por favor di sí otra vez para confirmar tu reserva.",
            ),
            log: `save_failed:${err?.message || err}`,
          };
        }
        session.completed = true;
        session.step = STATES.END;
        console.log("✅ Booking marked complete");
        // Email-only confirmation mode: no phone capture and no SMS language in voice responses.
        // If SMS is still enabled elsewhere in the backend, it must not affect voice replies.
        const closing = endCall({}, T);
        return {
          reply: closing.reply,
          log: "confirm→hard_close+email_confirmation",
          afterBookingClose: closing.afterBookingClose,
        };
      }
      if (isNo(normalized)) {
        session.step = STATES.SERVICE;
        session.data = {};
        session.completed = false;
        return {
          reply: T(
            "No problem. What would you like to change?",
            "Sin problema. ¿Qué te gustaría cambiar?",
          ),
          log: "confirm→service_reset",
        };
      }
      return {
        reply: T(
          "Please clearly say yes to confirm or no to make changes.",
          "Por favor di claramente sí para confirmar o no para hacer cambios.",
        ),
        log: "confirm_reprompt",
      };
    }
    case STATES.ANYTHING_ELSE: {
      const normalized = normalizeConfirmInput(input);
      const thankYou = T(
        "Thank you for choosing Imperial Foundation CDC. Have a great day.",
        "Gracias por elegir Imperial Foundation CDC. Que tengas un excelente día.",
      );
      if (isYes(normalized)) {
        session.data = {};
        session.step = STATES.SERVICE;
        return {
          reply: T("Great. What service would you like to book?", "Genial. ¿Qué servicio quieres reservar?"),
          log: "anything_else→service_new_booking",
        };
      }
      if (empty || isNo(normalized) || wantsToEndClosing(normalized)) {
        session.step = STATES.END;
        return {
          reply: thankYou,
          log: empty ? "anything_else→farewell_silence" : "anything_else→farewell_done",
          hangupFollowup: true,
        };
      }
      session.step = STATES.END;
      return {
        reply: thankYou,
        log: "anything_else→farewell_other",
        hangupFollowup: true,
      };
    }
    case STATES.END: {
      return {
        reply: "",
        log: "end_stale",
        hangupFollowup: true,
      };
    }
    default: {
      session.step = STATES.START;
      session.data = {};
      session.completed = false;
      return {
        reply: T("Let's keep going. What service would you like?", "Sigamos. ¿Qué servicio deseas?"),
        log: "unknown_step_reset",
      };
    }
  }
}

const WELCOME = "__IFCDC_VOICE_WELCOME__";
const NO_SPEECH = "__IFCDC_NO_SPEECH__";

/**
 * @param {{ callSid: string, userInput: string, language: string, insertVoiceRow?: (b: object) => Promise<object> }} ctx
 * @returns {Promise<{ reply: string, stage: string, bookingLog?: string, afterBookingClose?: boolean, duplicateExecutionBlocked?: boolean, hangupFollowup?: boolean }>}
 */
export async function runSimpleBookingTurn(ctx) {
  const callSid = String(ctx.callSid || "").trim();
  const rawIn = String(ctx.userInput || "").trim();
  let input = rawIn === WELCOME || rawIn === "hello" ? "" : rawIn;
  if (rawIn === NO_SPEECH) input = "no_input";

  const out = await handleBooking(callSid, input, ctx.language, ctx.insertVoiceRow);
  const session = getState(callSid);
  return {
    reply: out.reply,
    stage: session ? String(session.step) : "none",
    bookingLog: out.log,
    afterBookingClose: out.afterBookingClose,
    duplicateExecutionBlocked: out.duplicateExecutionBlocked,
    hangupFollowup: out.hangupFollowup,
  };
}

/** @deprecated use STATES */
export const SimpleBookingStage = STATES;
