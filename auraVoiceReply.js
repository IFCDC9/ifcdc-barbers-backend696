/**
 * AURA Twilio Voice — OpenAI replies + keyword fallback + safe TwiML text.
 * Default route: attachAuraVoiceRoutes uses this unless AURA_VOICE_WIZARD=1.
 *
 * Env: OPENAI_API_KEY, OPENAI_MODEL, VOICE_DEFAULT_BARBER_LANGUAGE_ID,
 *      PUBLIC_API_URL (required for default voice — https, no trailing slash),
 *      TWILIO_*, AURA_PHONE_NUMBER (+E.164).
 */

import twilio from "twilio";
import { auraStructuredIntentFromKeywords, auraKeywordFallbackReply } from "./auraIntent.js";
import { normalizeBarberLang, openAiLanguageInstruction, twilioSayAttributes } from "./auraLocale.js";
import { loadBarberSettingsRow } from "./barberScope.js";
import { runSimpleBookingTurn, getSimpleBookingStage, STATES } from "./auraVoiceSimpleBookingFlow.js";
import { isCallCompleted, markCallCompleted } from "./src/services/bookingLock.js";
import { createRequire } from "module";

const requireCjs = createRequire(import.meta.url);
const {
  isAuraVoiceIntelligencePhase1,
} = requireCjs("./auraVoiceIntelligenceFlags.cjs");
const { runVoiceIntelligenceTurn } = requireCjs("./auraVoiceIntelligenceOrchestrator.cjs");
const { waitingAckPhrase, recordVoiceTiming } = requireCjs("./auraVoiceLatency.cjs");
const {
  evaluateSpeechInput,
  rememberAssistantSpeech,
  twilioGatherSpeechAttrs,
  parseConfidence,
  getNoiseControlStats,
} = requireCjs("./auraVoiceNoiseControl.cjs");

const WELCOME_SENTINEL = "__IFCDC_VOICE_WELCOME__";
const NO_SPEECH_SENTINEL = "__IFCDC_NO_SPEECH__";

const VOICE_GUIDE_EN = " You can say book, services, or ask a question.";
const VOICE_GUIDE_ES = " Puedes decir reserva, servicios, o hacer una pregunta.";

const VOICE_SYSTEM_BASE = `You are AURA, a confident, intelligent assistant for Imperial Foundation CDC (never say the letters I-F-C-D-C as one mumbled acronym; say the full name or "Imperial Foundation CDC").
Speak clearly, avoid repeating yourself, guide the user, and always move the conversation forward.
Ask only one follow-up question at a time.
Help with bookings, services, and pricing without sounding robotic.
Do not ask for phone numbers. Never mention SMS. After booking, confirm that an email was sent and end the call cleanly.
Never announce a booking as successful until the backend booking confirmation has completed.`;

/** Per CallSid: first empty webhook → welcome; later empty (e.g. Gather timeout) → reprompt. */
const voiceGreetedCallSids = new Set();
const VOICE_GREET_TRACK_CAP = 2000;
function trackVoiceGreeting(callSid) {
  const k = String(callSid || "").trim();
  if (!k) return;
  while (voiceGreetedCallSids.size >= VOICE_GREET_TRACK_CAP) {
    const first = voiceGreetedCallSids.values().next().value;
    voiceGreetedCallSids.delete(first);
  }
  voiceGreetedCallSids.add(k);
}
function voiceAlreadyGreeted(callSid) {
  const k = String(callSid || "").trim();
  return Boolean(k && voiceGreetedCallSids.has(k));
}

/** Last “core” reply per call (before the closing guide line) — avoids saying the exact same line twice. */
const voiceLastCoreByCallSid = new Map();
const VOICE_LAST_CAP = 2000;
function rememberVoiceCore(callSid, core) {
  const k = String(callSid || "").trim();
  if (!k) return;
  while (voiceLastCoreByCallSid.size >= VOICE_LAST_CAP) {
    const first = voiceLastCoreByCallSid.keys().next().value;
    voiceLastCoreByCallSid.delete(first);
  }
  voiceLastCoreByCallSid.set(k, String(core || "").trim());
}
function getVoiceLastCore(callSid) {
  const k = String(callSid || "").trim();
  return k ? String(voiceLastCoreByCallSid.get(k) || "").trim() : "";
}

/**
 * `PUBLIC_API_URL` only — trimmed, no trailing slash. Empty if unset.
 */
export function getPublicApiBaseUrl() {
  return String(process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
}

/**
 * @throws {Error} if PUBLIC_API_URL is missing (default AURA voice requires it for Twilio Gather).
 * @returns {string} same as getPublicApiBaseUrl when set
 */
export function assertPublicApiUrlForAuraVoice() {
  const base = getPublicApiBaseUrl();
  if (!base) {
    throw new Error("PUBLIC_API_URL is required for AURA voice");
  }
  return base;
}

/** Same as assert — use for TwiML base. */
export function getVoiceWebhookBaseUrl() {
  return assertPublicApiUrlForAuraVoice();
}

/**
 * Full Gather action URL (always PUBLIC_API_URL origin, never localhost).
 * @param {string} [path="/api/aura/voice"]
 */
export function getVoiceGatherActionUrl(path = "/api/aura/voice") {
  const base = assertPublicApiUrlForAuraVoice();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base.replace(/\/$/, "")}${p}`;
}

function xmlEscapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text inside Twilio &lt;Say&gt; (not SSML). */
export function escapeTwilioSayText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 2000);
}

/** US 10-digit phone from Digits or speech (last 10 digits if 11 with leading 1). */
function extractTenDigitPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length === 10) return d;
  return "";
}

/**
 * Fast intent lines (before OpenAI).
 * @returns {string|null}
 */
function structuredVoiceIntent(raw, L) {
  const t = String(raw || "").trim();
  const lower = t.toLowerCase();
  if (L === "es") {
    if (/\b(reservar|reserva|cita|agendar|appointment|booking)\b/i.test(t)) {
      return "Perfecto, te ayudo. ¿Qué día te gustaría venir?";
    }
    if (/\b(precio|precios|cost|costo|cuánto|cuesta)\b/i.test(lower)) {
      return "Los precios varían según el servicio. ¿Qué estilo buscas?";
    }
    return null;
  }
  if (/\b(book|booking|appointment|schedule|reserve)\b/.test(lower)) {
    return "Great, I can help with that. What day would you like to come in?";
  }
  if (/\b(price|pricing|cost|how much|fee)\b/.test(lower)) {
    return "Prices vary by service. What style are you looking for?";
  }
  return null;
}

function appendVoiceGuide(core, L, skipGuide) {
  const c = String(core || "").trim();
  if (!c || skipGuide) return c;
  if (/\bYou can say book\b/i.test(c) || /\bPuedes decir reserva\b/i.test(c)) return c;
  return c + (L === "es" ? VOICE_GUIDE_ES : VOICE_GUIDE_EN);
}

/**
 * @param {string} userText
 * @param {string} langNorm "en" | "es"
 * @returns {Promise<string|null>} assistant text or null on failure / no key
 */
async function openAiVoiceCompletion(userText, langNorm) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const system = `${VOICE_SYSTEM_BASE}${openAiLanguageInstruction(langNorm)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: String(userText || "").slice(0, 2000) },
      ],
      max_tokens: 220,
      temperature: 0.65,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!r.ok || !reply) {
    console.warn("[aura/voice openai]", data.error?.message || `HTTP ${r.status}`);
    return null;
  }
  return reply;
}

/**
 * @param {string} userInput - Twilio SpeechResult or Digits
 * @param {{ language?: string, callSid?: string }} [opts]
 * @returns {Promise<string>} plain text for &lt;Say&gt;
 */
export async function generateAuraReply(userInput, opts = {}) {
  const L = normalizeBarberLang(opts.language);
  const callSid = String(opts.callSid || "").trim();
  const raw = String(userInput || "").trim();

  let core = "";
  let skipGuide = false;

  if (!raw) {
    core =
      L === "es"
        ? "Gracias por llamar a la aplicación IFCDC Barbers. Soy AURA, tu asistente virtual. Estoy aquí para ayudarte a agendar citas, responder preguntas y asistirte con nuestros servicios. ¿En qué puedo ayudarte hoy?"
        : "Thank you for calling the IFCDC Barbers App. This is AURA, your virtual assistant. I'm here to help you schedule appointments, answer questions, and assist with our services. How may I help you today?";
    skipGuide = true;
  } else if (raw === WELCOME_SENTINEL) {
    core =
      L === "es"
        ? "Gracias por llamar a la aplicación IFCDC Barbers. Soy AURA, tu asistente virtual. Estoy aquí para ayudarte a agendar citas, responder preguntas y asistirte con nuestros servicios. ¿En qué puedo ayudarte hoy?"
        : "Thank you for calling the IFCDC Barbers App. This is AURA, your virtual assistant. I'm here to help you schedule appointments, answer questions, and assist with our services. How may I help you today?";
    skipGuide = true;
  } else if (raw === NO_SPEECH_SENTINEL) {
    core =
      L === "es"
        ? "No escuché bien. ¿Qué día te conviene, o di reserva para empezar."
        : "Sorry, I didn't catch that. What day works for you, or say booking to get started.";
  } else {
    const ten = extractTenDigitPhone(raw);
    if (ten.length === 10 || (raw.length === 10 && /^\d{10}$/.test(raw))) {
      core =
        L === "es"
          ? "Gracias, anoté tu número para la reserva."
          : "Thanks, I've got that number down for your appointment.";
      skipGuide = true;
    } else {
      const hit = structuredVoiceIntent(raw, L);
      if (hit) {
        core = hit;
      } else {
        const ai = await openAiVoiceCompletion(raw, L);
        if (ai) {
          core = ai;
        } else {
          const kw = auraStructuredIntentFromKeywords(raw, L);
          if (kw.matched) {
            core = String(kw.reply || "").trim() || auraKeywordFallbackReply(L);
          } else {
            core = auraKeywordFallbackReply(L);
          }
        }
      }
    }
  }

  const last = getVoiceLastCore(callSid);
  if (last && last === String(core).trim()) {
    core =
      L === "es"
        ? "Déjame ayudarte con eso. ¿Qué te gustaría hacer ahora?"
        : "Let me help you with that. What would you like to do next?";
  }

  rememberVoiceCore(callSid, core);

  const out = appendVoiceGuide(core, L, skipGuide);
  return out.slice(0, 2000);
}

/** Legacy helper — simple AURA loop does not use &lt;Hangup/&gt;; wizard mode may still reference this. */
export function auraVoiceReplyShouldHangup(replyText) {
  return /booking is confirmed|appointment has been confirmed|reserva está confirmada/i.test(String(replyText || ""));
}

/**
 * Persist SpeechResult (and resolved welcome / no-speech) across /voice → /process Redirect.
 * Twilio often omits SpeechResult on the follow-up POST to /process; /voice always writes here first.
 * Relative TwiML URLs keep the same host Twilio already reached (avoids stale PUBLIC_API_URL).
 */
const callSessions = Object.create(null);
const CALL_SESSION_CAP = 2000;
const VOICE_WEBHOOK_PATH = "/api/aura/voice";
const VOICE_PROCESS_PATH = "/api/aura/process";
const SAFE_REPLY_MS = 5000;
const SETTINGS_BUDGET_MS = 3000;

function callSessionsPut(callSid, text, meta = null) {
  const k = String(callSid ?? "").trim();
  if (!k) return;
  while (Object.keys(callSessions).length >= CALL_SESSION_CAP) {
    const first = Object.keys(callSessions)[0];
    if (first === undefined) break;
    delete callSessions[first];
  }
  callSessions[k] = {
    text: String(text ?? ""),
    meta: meta && typeof meta === "object" ? meta : {},
  };
}

/** Read and remove so the next /process leg never reuses stale input. */
function callSessionsTake(callSid) {
  const k = String(callSid ?? "").trim();
  if (!k) return { text: "", meta: {} };
  const v = callSessions[k];
  delete callSessions[k];
  if (v == null) return { text: "", meta: {} };
  if (typeof v === "object" && v && "text" in v) {
    return { text: String(v.text ?? ""), meta: v.meta && typeof v.meta === "object" ? v.meta : {} };
  }
  return { text: String(v), meta: {} };
}

/**
 * OpenAI / keyword path capped at 5s — always resolves (never rejects) so Twilio always gets TwiML.
 * @param {string} input
 * @param {{ language?: string, callSid?: string }} [opts]
 */
async function safeGenerateReply(input, opts = {}) {
  const L = normalizeBarberLang(opts.language);
  const fallback =
    L === "es"
      ? "Estoy aquí contigo. ¿Qué te gustaría hacer?"
      : "I'm here with you. What would you like to do?";
  const t0 = Date.now();
  const ai = generateAuraReply(String(input ?? ""), opts).catch((err) => {
    console.error("AI ERROR:", err?.stack || err);
    return fallback;
  });
  const out = await Promise.race([
    ai,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), SAFE_REPLY_MS);
    }),
  ]);
  console.log("[aura/timing] generateAuraReply_race_ms", Date.now() - t0);
  return out;
}

function buildVoiceLoopTwiML(gatherAction, attrs, mainSay, stillHereSay, callSid = "") {
  const g = twilioGatherSpeechAttrs(callSid);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="${g.timeout}" speechTimeout="${g.speechTimeout}" bargeIn="${g.bargeIn}" enhanced="${g.enhanced}" speechModel="${g.speechModel}" method="POST" action="${gatherAction}">
    <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${mainSay}</Say>
  </Gather>
  <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${stillHereSay}</Say>
  <Redirect method="POST">${gatherAction}</Redirect>
</Response>`;
}

function twimlHangupGoodbye() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for choosing Imperial Foundation CDC. Have a great day.</Say>
  <Hangup/>
</Response>`;
}

/** Final thank-you, short pause, graceful Hangup (no Gather loop). `farewellEscaped` = output of escapeTwilioSayText. */
function buildFarewellHangupTwiML(attrs, farewellEscaped, pauseSeconds = 2) {
  const pl = Math.max(1, Math.min(4, Number(pauseSeconds) || 2));
  const inner = String(farewellEscaped || "").trim();
  const sayBlock =
    inner.length > 0
      ? `<Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${inner}</Say>
  `
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayBlock}<Pause length="${pl}"/>
  <Hangup/>
</Response>`;
}

/** Phone step: DTMF (up to 10 digits, # to finish) → POST /api/aura/process (Twilio posts Digits on that URL). */
function buildPhoneDtmfGatherTwiML(processAction, attrs, innerSay, stillHereSay) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="10" finishOnKey="#" action="${processAction}" method="POST" timeout="10">
    <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${innerSay}</Say>
  </Gather>
  <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${stillHereSay}</Say>
  <Redirect method="POST">${processAction}</Redirect>
</Response>`;
}

/**
 * Twilio voice: respond immediately, then POST /api/aura/process for booking + reply.
 * @param {{ insertVoiceRow?: (body: object) => Promise<object>, dbQuery?: Function }} [opts]
 * @returns {{ voice: import("express").RequestHandler, process: import("express").RequestHandler }}
 */
export function createSimpleAuraVoiceHandlers(opts = {}) {
  const insertVoiceRow = opts.insertVoiceRow;
  const dbQuery = opts.dbQuery;

  const voice = async (req, res) => {
    console.log("🚀 AURA WEBHOOK HIT", {
      route: "/api/aura/voice",
      method: String(req.method || "").toUpperCase(),
    });
    console.log("📞 Incoming call:", req.body);

    const env = typeof process !== "undefined" && process?.env && typeof process.env === "object" ? process.env : {};
    if (String(env.AURA_VOICE_DIAGNOSTIC || "").trim() === "1") {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("AURA is connected.");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const gatherLoop = xmlEscapeAttr(VOICE_WEBHOOK_PATH);
    const processPath = xmlEscapeAttr(VOICE_PROCESS_PATH);
    const tRoute = Date.now();
    try {
      if (String(req.method || "").toUpperCase() === "GET") {
        res.type("text/xml");
        console.log("[aura/voice] GET 200 probe");
        return res.send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna" language="en-US">AURA voice is up. Twilio should POST SpeechResult or Digits here.</Say></Response>`,
        );
      }

      console.log("VOICE HIT");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const q = req.query && typeof req.query === "object" ? req.query : {};
      const callSid = String(body.CallSid ?? q.CallSid ?? "").trim();
      if (!callSid) {
        console.warn(
          "[aura/flow] MISSING_LEG route=/api/aura/voice reason=POST_without_CallSid Twilio_body_keys=" +
            Object.keys(body).join(","),
        );
      }
      const speech = String(body.SpeechResult ?? "").trim();
      const digits = String(body.Digits ?? "").trim();
      const confidence = parseConfidence(body.Confidence ?? body.confidence);
      let userInput;
      if (speech || digits) {
        userInput = speech || digits;
      } else if (callSid && voiceAlreadyGreeted(callSid)) {
        userInput = NO_SPEECH_SENTINEL;
      } else {
        userInput = WELCOME_SENTINEL;
        if (callSid) trackVoiceGreeting(callSid);
      }
      console.log("CALL SID:", callSid || "(none)");
      console.log(
        "USER INPUT:",
        userInput === WELCOME_SENTINEL ? "(welcome)" : userInput === NO_SPEECH_SENTINEL ? "(no speech)" : userInput,
        confidence != null ? `conf=${confidence}` : "",
      );

      if (callSid) {
        callSessionsPut(callSid, userInput, {
          confidence,
          bargeInCandidate: Boolean(speech) && voiceAlreadyGreeted(callSid),
          unstable: String(body.UnstableSpeechResult || "").trim() || null,
        });
      } else {
        console.warn("[aura/flow] MISSING_LEG route=/api/aura/voice reason=no_CallSid_session_not_stored");
      }

      res.type("text/xml");
      // Welcome: skip filler so the professional greeting is the first thing callers hear.
      // Other turns: speak a short ack immediately while /process does the work (avoids silence).
      const isWelcome = userInput === WELCOME_SENTINEL;
      if (isWelcome) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${processPath}</Redirect>
</Response>`;
        res.send(xml);
      } else {
        const bridgeSay = escapeTwilioSayText(waitingAckPhrase(callSid));
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">${bridgeSay}</Say>
  <Redirect method="POST">${processPath}</Redirect>
</Response>`;
        res.send(xml);
      }
      console.log("[aura/timing] /api/aura/voice_ms", Date.now() - tRoute);
      console.log("[aura/flow] voice→process enqueued callSid=", callSid || "(none)", "welcome=", isWelcome);
      return;
    } catch (err) {
      console.error("❌ AURA ERROR:", err?.stack || err);
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("System error. Please try again.");
      res.type("text/xml");
      res.send(twiml.toString());
      console.log("[aura/timing] /api/aura/voice_ms", Date.now() - tRoute);
      return;
    }
  };

  const process = async (req, res) => {
    const gatherAction = xmlEscapeAttr(VOICE_WEBHOOK_PATH);
    const processAction = xmlEscapeAttr(VOICE_PROCESS_PATH);
    const tRoute = Date.now();
    let sent = false;
    const sendGlobalFallback = (reason) => {
      if (sent || res.headersSent) return;
      sent = true;
      console.error("[aura/process] FALLBACK_TWIML route=/api/aura/process reason=", reason);
      try {
        res.type("text/xml");
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">I'm still here. Let's keep going. What service would you like today?</Say>
  <Redirect method="POST">${gatherAction}</Redirect>
</Response>`);
      } catch (e) {
        console.error("[aura/process] FALLBACK_SEND_FAILED:", e?.stack || e);
      }
    };

    try {
      console.log("🚀 AURA PROCESS HIT", { route: "/api/aura/process", method: String(req.method || "").toUpperCase() });
      console.log("PROCESS HIT");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      console.log("📞 Process webhook body:", body);
      const q = req.query && typeof req.query === "object" ? req.query : {};
      const callSid = String(body.CallSid ?? q.CallSid ?? "").trim();
      console.log("CALL SID:", callSid || "(none)");
      console.log("📌 Call completed (session flag):", Boolean(req.session?.bookingCompleted));
      console.log("📌 Call completed (lock):", isCallCompleted(callSid));

      if (req.session?.bookingCompleted) {
        console.log("📞 Ending call (session already completed)");
        sent = true;
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }

      if (isCallCompleted(callSid)) {
        console.log("📞 Ending call (lock already completed)");
        res.type("text/xml");
        res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
        sent = true;
        return;
      }

      const sessionPeek = callSid ? callSessions[callSid] : null;
      const digitsBody = String(body.Digits ?? "").trim();
      const speechBody = String(body.SpeechResult ?? "").trim();
      const confBody = parseConfidence(body.Confidence ?? body.confidence);
      let stashed = { text: "", meta: {} };
      let userInput = "";
      if (digitsBody) userInput = digitsBody;
      else if (speechBody) userInput = speechBody;
      else {
        stashed = callSessionsTake(callSid);
        userInput = stashed.text;
      }
      if (!String(userInput).trim()) {
        if (getSimpleBookingStage(callSid) === STATES.ANYTHING_ELSE) {
          userInput = NO_SPEECH_SENTINEL;
        } else if (callSid && !(sessionPeek && String(sessionPeek?.text || sessionPeek || "").trim())) {
          console.warn(
            "[aura/flow] MISSING_LEG route=/api/aura/process reason=callSessions_empty_after_take " +
              "(Redirect_POST_without_matching_voice_stash?) callSid=" +
              callSid,
          );
          userInput = "hello";
        } else {
          userInput = "hello";
        }
      }
      const speechConfidence =
        confBody != null ? confBody : stashed.meta?.confidence != null ? stashed.meta.confidence : null;
      const isWelcome = userInput === WELCOME_SENTINEL;
      const isNoSpeech = userInput === NO_SPEECH_SENTINEL;
      const gate = evaluateSpeechInput({
        callSid,
        speechText: isWelcome || isNoSpeech ? userInput : userInput,
        confidenceRaw: speechConfidence,
        digits: digitsBody,
        isWelcome,
        isNoSpeech,
        isBargeInCandidate: Boolean(stashed.meta?.bargeInCandidate) && !digitsBody,
      });
      console.log("USER INPUT:", gate.text || userInput, digitsBody ? "(Digits)" : speechBody ? "(SpeechResult)" : "", {
        gate: gate.action,
        reason: gate.reason,
        confidence: gate.confidence,
        gateMs: gate.metrics?.gateMs,
      });

      if (gate.action === "reject_prompt" || gate.action === "confirm_critical") {
        let language = "en";
        let voiceType = "Polly.Joanna";
        try {
          const env =
            typeof process !== "undefined" && process?.env && typeof process.env === "object" ? process.env : {};
          const bid = Number(env.VOICE_DEFAULT_BARBER_LANGUAGE_ID || "1") || 1;
          const st = await Promise.race([
            loadBarberSettingsRow(bid),
            new Promise((resolve) => setTimeout(() => resolve(null), SETTINGS_BUDGET_MS)),
          ]);
          if (st && typeof st === "object") {
            language = st?.language || "en";
            voiceType = st?.aura_voice_type || "Polly.Joanna";
          }
        } catch {
          /* keep defaults */
        }
        const attrs = twilioSayAttributes(language, voiceType);
        const prompt = escapeTwilioSayText(String(gate.prompt || "Could you please repeat that?"));
        const stillHere = escapeTwilioSayText("I'm still here if you need me.");
        rememberAssistantSpeech(callSid, gate.prompt || "");
        res.type("text/xml");
        res.send(buildVoiceLoopTwiML(gatherAction, attrs, prompt, stillHere, callSid));
        sent = true;
        recordVoiceTiming({
          speechToResponseMs: Date.now() - tRoute,
          responseGenerationMs: gate.metrics?.gateMs ?? Date.now() - tRoute,
          totalTurnMs: Date.now() - tRoute,
        });
        console.log("[aura/noise] gated", gate.action, gate.reason, "noisy=", gate.noisyMode);
        return;
      }

      if (gate.action === "use_pending" || gate.action === "accept") {
        userInput = gate.text || userInput;
      }
      console.log("USER INPUT (gated):", userInput, digitsBody ? "(Digits)" : speechBody ? "(SpeechResult)" : "");

      let language = "en";
      let voiceType = "Polly.Joanna";
      const tSettings = Date.now();
      try {
        const env =
          typeof process !== "undefined" && process?.env && typeof process.env === "object" ? process.env : {};
        const bid = Number(env.VOICE_DEFAULT_BARBER_LANGUAGE_ID || "1") || 1;
        const st = await Promise.race([
          loadBarberSettingsRow(bid),
          new Promise((resolve) => setTimeout(() => resolve(null), SETTINGS_BUDGET_MS)),
        ]);
        if (st && typeof st === "object") {
          language = st?.language || "en";
          voiceType = st?.aura_voice_type || "Polly.Joanna";
        }
      } catch (e) {
        console.warn("[aura/voice process] settings:", e?.message || e);
      }
      console.log("[aura/timing] /api/aura/process_settings_ms", Date.now() - tSettings);

      const attrs = twilioSayAttributes(language, voiceType);

      /** Phase 1 intelligence (flagged) — never replaces Twilio Verify / SMS / PayPal. */
      if (isAuraVoiceIntelligencePhase1()) {
        try {
          const fromE164 = String(body.From ?? q.From ?? "").trim();
          const toE164 = String(body.To ?? q.To ?? "").trim();
          const intel = await runVoiceIntelligenceTurn({
            dbQuery,
            callSid,
            from: fromE164,
            to: toE164,
            userInput,
            insertVoiceRow,
            language,
          });
          if (intel?.handled && String(intel.reply || "").trim()) {
            const genMs = Date.now() - tRoute;
            recordVoiceTiming({
              speechToResponseMs: genMs,
              responseGenerationMs: genMs,
              totalTurnMs: Date.now() - tRoute,
            });
            res.type("text/xml");
            if (intel.afterBookingClose || intel.hangup) {
              markCallCompleted(callSid);
              req.session.bookingCompleted = true;
              const closingSay = escapeTwilioSayText(String(intel.reply).trim());
              res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${closingSay}</Say>
  <Hangup/>
</Response>`);
              sent = true;
              console.log("[aura/flow] twiml=voice_intel_close intent=", intel.intent || "");
              return;
            }
            const safeMain = escapeTwilioSayText(String(intel.reply).trim());
            const stillHere = escapeTwilioSayText("I'm still here if you need me.");
            rememberAssistantSpeech(callSid, String(intel.reply).trim());
            res.send(buildVoiceLoopTwiML(gatherAction, attrs, safeMain, stillHere, callSid));
            sent = true;
            console.log("[aura/flow] twiml=voice_intel intent=", intel.intent || "");
            return;
          }
        } catch (intelErr) {
          console.warn("[aura/voice-intel] turn failed; falling back to legacy:", intelErr?.message || intelErr);
        }
      }

      const tBook = Date.now();
      const bookingOut = await runSimpleBookingTurn({
        callSid,
        userInput,
        language,
        insertVoiceRow,
      });
      console.log("[aura/timing] simple_booking_turn_ms", Date.now() - tBook);
      console.log("STAGE:", bookingOut.stage, bookingOut.bookingLog ? `(${bookingOut.bookingLog})` : "");
      recordVoiceTiming({
        bookingLookupMs: Date.now() - tBook,
        responseGenerationMs: Date.now() - tBook,
        totalTurnMs: Date.now() - tRoute,
        speechToResponseMs: Date.now() - tRoute,
      });

      res.type("text/xml");

      if (bookingOut.duplicateExecutionBlocked) {
        console.log("⚠️ Duplicate execution blocked (booking flow)");
        console.log("📞 Ending call");
        res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
        sent = true;
        return;
      }

      if (bookingOut.afterBookingClose) {
        markCallCompleted(callSid);
        req.session.bookingCompleted = true;
        res.set("Content-Type", "text/xml");
        const L = normalizeBarberLang(language);
        const closingText =
          L === "es"
            ? "Todo listo. Tu cita está confirmada. Gracias por elegir IFCDC."
            : "You're all set. Your appointment has been confirmed. Thank you for choosing IFCDC.";
        const closingSay = escapeTwilioSayText(closingText);
        console.log("📞 Ending call now");
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${closingSay}</Say>
  <Hangup/>
</Response>
`);
        sent = true;
        console.log("[aura/flow] twiml=post_booking_close_hangup callSid=", callSid || "(none)");
        console.log("[aura/timing] /api/aura/process_total_ms", Date.now() - tRoute);
        return;
      }

      if (bookingOut.hangupFollowup) {
        const farewell = escapeTwilioSayText(String(bookingOut.reply ?? "").trim());
        res.send(buildFarewellHangupTwiML(attrs, farewell, 2));
        sent = true;
        console.log("[aura/flow] twiml=farewell_hangup");
        console.log("[aura/timing] /api/aura/process_total_ms", Date.now() - tRoute);
        return;
      }

      let reply = String(bookingOut.reply ?? "").trim();
      if (!reply) {
        console.warn("[aura/flow] MISSING_LEG route=/api/aura/process reason=empty_booking_reply_using_safeGenerate");
        reply = await safeGenerateReply(userInput, { language, callSid });
        reply = String(reply ?? "").trim();
      }
      if (!reply) {
        reply =
          normalizeBarberLang(language) === "es"
            ? "Hola, estoy aquí. ¿Cómo puedo ayudarte hoy?"
            : "I'm here. How can I help you today?";
      }
      console.log("REPLY:", reply.slice(0, 400) + (reply.length > 400 ? "…" : ""));

      const safeMain = escapeTwilioSayText(
        reply ||
          (normalizeBarberLang(language) === "es"
            ? "Hola, estoy aquí. ¿Cómo puedo ayudarte hoy?"
            : "I'm here. How can I help you today?"),
      );
      const stillHere = escapeTwilioSayText(
        normalizeBarberLang(language) === "es"
          ? "Sigo aquí si me necesitas."
          : "I'm still here if you need me.",
      );

      rememberAssistantSpeech(callSid, reply);
      res.send(buildVoiceLoopTwiML(gatherAction, attrs, safeMain, stillHere, callSid));
      sent = true;
      console.log("[aura/timing] /api/aura/process_total_ms", Date.now() - tRoute);
      console.log(
        "[aura/flow] sequence_ok legs=VOICE_HIT,CALL_SID,USER_INPUT,PROCESS_HIT,REPLY callSid=",
        callSid || "(none)",
      );
      return;
    } catch (err) {
      console.error("❌ AURA ERROR:", err?.stack || err);
      try {
        if (!res.headersSent) {
          const twiml = new twilio.twiml.VoiceResponse();
          twiml.say("System error. Please try again.");
          res.type("text/xml");
          res.send(twiml.toString());
          sent = true;
          console.log("[aura/process] POST 200 twiml (VoiceResponse error)");
        }
      } catch (sendErr) {
        console.error("[aura/process] nested_send_error:", sendErr?.stack || sendErr);
        sendGlobalFallback(String(sendErr?.message || sendErr));
      }
      return;
    } finally {
      if (!sent && !res.headersSent) {
        sendGlobalFallback("finally_guard_no_TwiML_sent");
      }
    }
  };

  return { voice, process };
}

/** @deprecated Use createSimpleAuraVoiceHandlers(opts).voice */
export function createSimpleAuraVoiceMiddleware(opts = {}) {
  return createSimpleAuraVoiceHandlers(opts).voice;
}
