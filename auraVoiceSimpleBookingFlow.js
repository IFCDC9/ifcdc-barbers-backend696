/**
 * Strict step-by-step voice booking for simple AURA (non-wizard).
 * One state advance per valid utterance — no AI step-skipping.
 */

import { ack } from "./auraVoiceAck.js";
import { createRequire } from "module";

const requireCjs = createRequire(import.meta.url);
const {
  mergeBookingInfo,
  setPendingQuestion,
  markQuestionAnswered,
  getBookingMachine,
  resetBookingMachine,
  isCallGreeted,
  markCallGreeted,
} = requireCjs("./auraVoiceCallRuntime.cjs");

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

/**
 * Booking wizard lives on the CallSid runtime session (same Map as turns).
 * @param {string} callSid
 * @returns {{ step: string, data: Record<string, string>, completed: boolean } | null}
 */
function getState(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return null;
  return getBookingMachine(k);
}

export function resetSimpleBookingState(callSid) {
  const k = String(callSid || "").trim();
  if (k) resetBookingMachine(k);
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

function parseWeekdayToYmd(speech) {
  const s = String(speech || "").toLowerCase();
  const weekdays = [
    ["sunday", 0],
    ["monday", 1],
    ["tuesday", 2],
    ["wednesday", 3],
    ["thursday", 4],
    ["friday", 5],
    ["saturday", 6],
  ];
  let target = null;
  for (const [name, idx] of weekdays) {
    if (new RegExp(`\\b${name}\\b`).test(s)) {
      target = idx;
      break;
    }
  }
  if (target === null) return "";
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const delta = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (delta === 0 ? 7 : delta));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDayFromSpeech(raw) {
  const s = String(raw || "").toLowerCase();
  if (/\btomorrow\b/.test(s)) return ymdTomorrow();
  if (/\btoday\b/.test(s)) return ymdToday();
  const iso = String(raw || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  return parseWeekdayToYmd(s);
}

const HOUR_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function hourToHHmm(h, mi = 0, ap = "") {
  let hour = Number(h);
  if (!Number.isFinite(hour)) return "";
  const minutes = Number.isFinite(Number(mi)) ? Number(mi) : 0;
  let mer = String(ap || "").toLowerCase().replace(/\./g, "");
  if (!mer) {
    if (hour >= 13 && hour <= 23) {
      return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
    if (hour >= 1 && hour <= 7) mer = "pm";
    else if (hour >= 8 && hour <= 11) mer = "am";
    else if (hour === 12) mer = "pm";
    else mer = "pm";
  }
  if (mer.startsWith("p") && hour < 12) hour += 12;
  if (mer.startsWith("a") && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return "";
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseTimeFromSpeech(raw) {
  const lower = String(raw || "")
    .toLowerCase()
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, " ");
  if (/\b(morning|early)\b/.test(lower) && !/\b(afternoon|evening|night)\b/.test(lower) && !/\b\d{1,2}\b/.test(lower)) {
    return "10:00";
  }
  if (/\b(afternoon|after lunch)\b/.test(lower) && !/\b\d{1,2}\b/.test(lower)) return "14:00";
  if (/\b(evening|after work|night)\b/.test(lower) && !/\b\d{1,2}\b/.test(lower)) return "17:00";
  const ampm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (ampm) return hourToHHmm(ampm[1], ampm[2] || 0, ampm[3]);
  const t24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t24) return `${String(t24[1]).padStart(2, "0")}:${t24[2]}`;
  const around = lower.match(/\b(?:around|about|at|by|near)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (around) return hourToHHmm(around[1], around[2] || 0, around[3] || "");
  for (const [word, n] of Object.entries(HOUR_WORDS)) {
    const wm = lower.match(new RegExp(`\\b(?:around|about|at|by)?\\s*${word}\\b(?:\\s*(a\\.?m\\.?|p\\.?m\\.?))?`, "i"));
    if (wm) return hourToHHmm(n, 0, wm[1] || "");
  }
  const bare = lower.match(/\b(\d{1,2})\s*(?:o'?clock)?\b/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    if (h >= 1 && h <= 12) return hourToHHmm(h, 0, "");
  }
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
  if (/^(hello|hi|hey|yo|thanks|thank you|ok|okay|please)$/i.test(lower)) return "";
  if (/\b(fade|taper|lineup|buzz)\b/.test(lower)) {
    const m = lower.match(/\b(fade|taper|lineup|buzz)\b/);
    return m ? m[1] : "";
  }
  if (/\b(beard|mustache)\b/.test(lower)) return "Beard trim";
  if (/\b(haircut|hair cut|cut|trim)\b/.test(lower)) return "Haircut";
  if (parseDayFromSpeech(t) || parseTimeFromSpeech(t)) return "";
  if (looksLikePhoneOnly(t)) return "";
  return "";
}

function extractSlots(raw) {
  const text = String(raw || "").trim();
  if (!text || text === "no_input") return { service: "", day: "", time: "" };
  return {
    service: inferService(text),
    day: parseDayFromSpeech(text),
    time: parseTimeFromSpeech(text),
  };
}

function applySlots(data, slots) {
  if (slots.service) data.service = slots.service;
  if (slots.day) {
    data.dateYmd = slots.day;
    data.day = slots.day;
  }
  if (slots.time) data.time = slots.time;
}

function missingBookingStep(data) {
  if (!data.service) return STATES.SERVICE;
  if (!data.dateYmd && !data.day) return STATES.DAY;
  if (!data.time) return STATES.TIME;
  if (!data.name) return STATES.NAME;
  return STATES.CONFIRM;
}

function promptFor(step, T, data = {}) {
  switch (step) {
    case STATES.SERVICE:
      return T(
        "What service should I book? For example, say haircut, fade, or beard trim.",
        "¿Qué servicio reservo? Por ejemplo, di corte, fade o barba.",
      );
    case STATES.DAY:
      return T(
        data.service ? `${data.service}. What day works best? Say today, tomorrow, or a date.` : "What day works best? Say today, tomorrow, or a date.",
        data.service ? `${data.service}. ¿Qué día te viene bien? Di hoy, mañana, o una fecha.` : "¿Qué día te viene bien? Di hoy, mañana, o una fecha.",
      );
    case STATES.TIME:
      return T(
        data.dateYmd
          ? `I have ${data.dateYmd}. What time would you like? Say morning, afternoon, or a time like two P M.`
          : "What time would you like? Say morning, afternoon, or a time like two P M.",
        data.dateYmd
          ? `Tengo el ${data.dateYmd}. ¿Qué hora quieres? Di mañana, tarde, o una hora.`
          : "¿Qué hora quieres? Di mañana, tarde, o una hora.",
      );
    case STATES.NAME:
      return T("Can I get your name for the appointment?", "¿Cuál es tu nombre para la cita?");
    case STATES.CONFIRM: {
      const timeDisplay = data.time || "";
      return T(
        `Just to confirm, ${data.name}, you want a ${data.service} on ${data.dateYmd} at ${timeDisplay}. Please say yes to confirm your booking or no to change it.`,
        `Confirmo: ${data.name}, ${data.service} el ${data.dateYmd} a las ${timeDisplay}. Di sí para confirmar la reserva o no para cambiarla.`,
      );
    }
    default:
      return T("Let's keep going. What service would you like?", "Sigamos. ¿Qué servicio deseas?");
  }
}

export { extractSlots, parseTimeFromSpeech, parseDayFromSpeech, inferService };

function syncLedgerFromSession(callSid, session, log) {
  if (!callSid || !session) return;
  mergeBookingInfo(callSid, {
    service: session.data.service,
    day: session.data.dateYmd || session.data.day,
    time: session.data.time,
    name: session.data.name,
    confirmed: session.completed === true,
  });
  const pendingByStep = {
    [STATES.SERVICE]: "What service should I book?",
    [STATES.DAY]: "What day works best?",
    [STATES.TIME]: "What time would you like?",
    [STATES.NAME]: "What name should I put on the booking?",
    [STATES.CONFIRM]: "Please say yes to confirm or no to change.",
  };
  if (pendingByStep[session.step]) {
    setPendingQuestion(callSid, pendingByStep[session.step], "book");
  } else {
    setPendingQuestion(callSid, "", session.completed ? "booked" : null);
  }
  if (log && /→/.test(String(log))) markQuestionAnswered(callSid, String(log));
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
const START_GREETING_EN = "Hi, this is Aura. How can I help you today?";
const START_GREETING_ES = "Hola, soy Aura. ¿En qué te puedo ayudar hoy?";

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
  const alreadyGreeted = isCallGreeted(callSid);

  if (!alreadyGreeted && empty) {
    markCallGreeted(callSid);
    session.step = STATES.SERVICE;
    return {
      reply: T(START_GREETING_EN, START_GREETING_ES),
      log: "start→service",
    };
  }
  if (!alreadyGreeted) markCallGreeted(callSid);
  if (session.step === STATES.START) session.step = STATES.SERVICE;

  switch (session.step) {
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
      const before = missingBookingStep(d);
      if (!empty) {
        const slots = extractSlots(trimmed);
        if (
          !slots.service &&
          before === STATES.SERVICE &&
          !slots.day &&
          !slots.time &&
          !looksLikePhoneOnly(trimmed) &&
          trimmed.length >= 3
        ) {
          slots.service = trimmed.replace(/\s+/g, " ").slice(0, 80);
        }
        applySlots(d, slots);
        const onlyNameMissing = Boolean(d.service && (d.dateYmd || d.day) && d.time && !d.name);
        if (
          onlyNameMissing &&
          !slots.service &&
          !slots.day &&
          !slots.time &&
          !looksLikePhoneOnly(trimmed) &&
          trimmed.length >= 2
        ) {
          d.name = trimmed.replace(/\s+/g, " ").slice(0, 80);
        }
        if (session.step === STATES.TIME && !d.time && trimmed.length >= 2 && !slots.day && !slots.service) {
          const parsed = parseTimeFromSpeech(trimmed);
          d.time = parsed || trimmed.slice(0, 120);
        }
      }
      const next = missingBookingStep(d);
      session.step = next;
      if (empty) {
        return {
          reply: promptFor(next, T, d),
          log: `${before}_reprompt_silence`,
        };
      }
      if (next === before) {
        const log =
          next === STATES.SERVICE
            ? "service_reprompt"
            : next === STATES.DAY
              ? "day_reprompt"
              : next === STATES.TIME
                ? "time_reprompt_short"
                : next === STATES.NAME
                  ? "name_reprompt"
                  : "confirm_reprompt";
        return { reply: promptFor(next, T, d), log };
      }
      const a = ack(callSid, L);
      if (next === STATES.CONFIRM && d.name) {
        return {
          reply: `${a} ${promptFor(STATES.CONFIRM, T, d)}`,
          log: `${before}→confirm`,
        };
      }
      const arrow =
        before === STATES.SERVICE && next === STATES.DAY
          ? "service→day"
          : before === STATES.DAY && next === STATES.TIME
            ? "day→time"
            : before === STATES.TIME && next === STATES.NAME
              ? "time→name"
              : before === STATES.NAME && next === STATES.CONFIRM
                ? "name→confirm"
                : `${before}→${next}`;
      return {
        reply: `${a} ${promptFor(next, T, d)}`,
        log: arrow,
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
  let input = rawIn === WELCOME ? "" : rawIn;
  if (rawIn === NO_SPEECH) input = "no_input";

  const out = await handleBooking(callSid, input, ctx.language, ctx.insertVoiceRow);
  const session = getState(callSid);
  syncLedgerFromSession(callSid, session, out.log);
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
