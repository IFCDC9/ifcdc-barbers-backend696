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
import {
  normalizeBarberLang,
  openAiLanguageInstruction,
  twilioSayAttributes,
  resolveVoiceReplyLang,
} from "./auraLocale.js";
import { loadBarberSettingsRow } from "./barberScope.js";
import { runSimpleBookingTurn } from "./auraVoiceSimpleBookingFlow.js";
import { isCallCompleted, markCallCompleted } from "./src/services/bookingLock.js";
import { createRequire } from "module";

const requireCjs = createRequire(import.meta.url);
const {
  isAuraVoiceIntelligencePhase1,
} = requireCjs("./auraVoiceIntelligenceFlags.cjs");
const { runVoiceIntelligenceTurn } = requireCjs("./auraVoiceIntelligenceOrchestrator.cjs");
const { recordVoiceTiming } = requireCjs("./auraVoiceLatency.cjs");
const {
  evaluateSpeechInput,
  rememberAssistantSpeech,
  twilioGatherSpeechAttrs,
  parseConfidence,
  conversationallyRelevant,
} = requireCjs("./auraVoiceNoiseControl.cjs");
const {
  beginCallerTurn,
  recordRejectedInput,
  recordAuraTurn,
  markPlaybackSpeaking,
  markBargeIn,
  mergeBookingInfo,
  ledgerContextBlock,
  applyRepeatGuard,
  rememberReplay,
  runExclusiveTurn,
  setCallLanguage,
  getCallLanguage,
  resolveTurnInput,
  isCallGreeted,
  markCallGreeted,
  conversationMessages,
  getCallRuntime,
  getTurn,
  getTurnByTwilioEvent,
  recordTurnTrace,
  snapshotLedger,
  contextSummary,
  stashTurnInput,
} = requireCjs("./auraVoiceCallRuntime.cjs");
const { tryVoiceboxPlayUrl } = requireCjs("./auraVoiceboxBridge.cjs");
const { prepareSpokenText } = requireCjs("./auraVoicePronunciation.cjs");
const { AURA_ALLAH_NAME } = requireCjs("./auraVoiceboxProfile.cjs");

const streamingContinueByCall = new Map();

const WELCOME_SENTINEL = "__IFCDC_VOICE_WELCOME__";
const NO_SPEECH_SENTINEL = "__IFCDC_NO_SPEECH__";
const START_GREETING_EN = "Hi, this is Aura. How can I help you today?";
const START_GREETING_ES = "Hola, soy Aura. ¿En qué te puedo ayudar hoy?";

const VOICE_GUIDE_EN = " You can say book, services, or ask a question.";
const VOICE_GUIDE_ES = " Puedes decir reserva, servicios, o hacer una pregunta.";

const VOICE_SYSTEM_BASE = `You are Aura, a confident, intelligent assistant for Imperial Foundation CDC (never say the letters I-F-C-D-C as one mumbled acronym; say the full name or "Imperial Foundation CDC"). Never say "Aura Allah". Introduce yourself as Aura.
Speak clearly, avoid repeating yourself, guide the user, and always move the conversation forward.
Ask only one follow-up question at a time.
Help with bookings, services, and pricing without sounding robotic.
Do not ask for phone numbers. Never mention SMS. After booking, confirm that an email was sent and end the call cleanly.
Never announce a booking as successful until the backend booking confirmation has completed.`;

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
async function openAiVoiceCompletion(userText, langNorm, opts = {}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const system = `${VOICE_SYSTEM_BASE}${openAiLanguageInstruction(langNorm)}`;
  const history = Array.isArray(opts.history) ? opts.history.slice(-8) : [];
  const messages = [
    { role: "system", content: system },
    ...history.filter((m) => m && m.content && m.role !== "system"),
    { role: "user", content: String(userText || "").slice(0, 2800) },
  ];
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
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
  const greeted = callSid ? isCallGreeted(callSid) : false;

  if (!raw || raw === WELCOME_SENTINEL) {
    if (greeted) {
      core =
        L === "es"
          ? "Sigo aquí. ¿Qué servicio quieres, o qué día te conviene?"
          : "I'm here. What service would you like, or what day works?";
      skipGuide = true;
    } else {
      core = L === "es" ? START_GREETING_ES : START_GREETING_EN;
      skipGuide = true;
      if (callSid) markCallGreeted(callSid);
    }
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
        const ledger = callSid ? ledgerContextBlock(callSid) : "";
        const history = callSid ? conversationMessages(callSid) : [];
        const ai = await openAiVoiceCompletion(ledger ? `${ledger}\n\nCaller: ${raw}` : raw, L, {
          history,
        });
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

  const guarded = applyRepeatGuard(callSid, core, { userText: raw });
  core = guarded.reply;
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

const VOICE_WEBHOOK_PATH = "/api/aura/voice";
const VOICE_PROCESS_PATH = "/api/aura/process";
const SAFE_REPLY_MS = 5000;
const SETTINGS_BUDGET_MS = 3000;

function twilioEventIdFromBody(body = {}) {
  return String(body.RequestSid || "").trim();
}

function ingestGatherTurn(callSid, body, { greeted, source = "gather" } = {}) {
  const speech = String(body.SpeechResult ?? "").trim();
  const digits = String(body.Digits ?? "").trim();
  const unstable = String(body.UnstableSpeechResult ?? "").trim();
  const confidence = parseConfidence(body.Confidence ?? body.confidence);
  const twilioEventId = twilioEventIdFromBody(body);
  let userInput;
  if (speech || digits) userInput = speech || digits;
  else if (unstable && !speech) {
    return {
      userInput: "",
      turn: {
        accepted: false,
        interim: true,
        duplicate: false,
        reason: "interim_not_a_turn",
        turnId: "",
        replayTwiml: "",
        transcriptHash: "",
        twilioEventId,
        transcriptFinal: false,
      },
      speech,
      digits,
      unstable,
      confidence,
    };
  } else if (callSid && greeted) {
    userInput = NO_SPEECH_SENTINEL;
  } else {
    userInput = WELCOME_SENTINEL;
  }
  const playbackSpeaking = Boolean(callSid && getCallRuntime(callSid).playback?.speaking);
  const bargeInWhileSpeaking = Boolean(speech) && playbackSpeaking;
  const fragmentBarge =
    bargeInWhileSpeaking &&
    !conversationallyRelevant(speech) &&
    (speech.length < 14 || speech.split(/\s+/).filter(Boolean).length < 3);
  const turn = callSid
    ? beginCallerTurn(callSid, {
        speech: speech || (userInput === WELCOME_SENTINEL || userInput === NO_SPEECH_SENTINEL ? userInput : ""),
        digits,
        confidence,
        source: bargeInWhileSpeaking ? "bargein" : source,
        twilioEventId,
        transcriptFinal: true,
        unstable,
      })
    : { accepted: true, turnId: "", eventId: "", duplicate: false, twilioEventId, transcriptHash: "" };
  if (callSid && turn.accepted && !turn.duplicate) {
    stashTurnInput(callSid, {
      text: userInput,
      turnId: turn.turnId,
      eventId: turn.eventId,
      twilioEventId: turn.twilioEventId,
      transcriptHash: turn.transcriptHash,
      confidence,
      bargeInCandidate: fragmentBarge,
      source: bargeInWhileSpeaking ? "bargein" : source,
    });
  }
  if (bargeInWhileSpeaking && callSid && turn.accepted && !turn.sameTurn) {
    markBargeIn(callSid);
  }
  if (callSid) getCallRuntime(callSid).playback.speaking = false;
  return { userInput, turn, speech, digits, unstable, confidence, bargeInCandidate: fragmentBarge };
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

function utteranceXml(attrs, escapedText, playUrl = null) {
  if (Array.isArray(playUrl)) {
    return playUrl
      .filter(Boolean)
      .map((u) => `<Play>${xmlEscapeAttr(u)}</Play>`)
      .join("\n    ");
  }
  if (playUrl) return `<Play>${xmlEscapeAttr(playUrl)}</Play>`;
  return `<Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${escapedText}</Say>`;
}

async function voiceboxOrPollyUtterance(attrs, rawText, escapedText, { callSid, language, from, audioId }) {
  const prepared = prepareSpokenText(rawText, { language });
  const attempt = await tryVoiceboxPlayUrl({
    text: prepared,
    language,
    conversationId: callSid,
    voiceProfile: AURA_ALLAH_NAME,
    from,
  });
  const usedId = attempt.generationId || audioId || null;
  if (attempt.streaming && attempt.continueToken && callSid) {
    streamingContinueByCall.set(String(callSid), {
      token: attempt.continueToken,
      language,
      audioId: usedId,
    });
  }
  let xml = utteranceXml(attrs, escapedText, null);
  if (attempt.used && attempt.urls?.length) xml = utteranceXml(attrs, escapedText, attempt.urls);
  else if (attempt.used && attempt.url) xml = utteranceXml(attrs, escapedText, attempt.url);
  return { xml, audioId: usedId, playUrl: attempt.url || null };
}

function buildVoiceLoopTwiML(gatherAction, attrs, mainInner, stillHereInner, callSid = "") {
  const g = twilioGatherSpeechAttrs(callSid);
  const pending = callSid ? streamingContinueByCall.get(String(callSid)) : null;
  if (pending?.token) {
    streamingContinueByCall.delete(String(callSid));
    const base = getPublicApiBaseUrl();
    if (base && !/localhost|127\.0\.0\.1/i.test(base)) {
      const qs = new URLSearchParams({
        gather: String(gatherAction || ""),
        callSid: String(callSid),
        language: String(pending.language || "en"),
      });
      const cont = `${base}/api/aura/voicebox/continue/${encodeURIComponent(pending.token)}?${qs.toString()}`;
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${mainInner}
  <Redirect method="POST">${cont}</Redirect>
</Response>`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="${g.timeout}" speechTimeout="${g.speechTimeout}" bargeIn="${g.bargeIn}" enhanced="${g.enhanced}" speechModel="${g.speechModel}" method="POST" action="${gatherAction}">
    ${mainInner}
  </Gather>
  ${stillHereInner}
  <Redirect method="POST">${gatherAction}</Redirect>
</Response>`;
}

/** Keep listening without speaking (noise / echo / barge-in fragment). */
function buildSilentListenTwiML(gatherAction, callSid = "") {
  const g = twilioGatherSpeechAttrs(callSid);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="${g.timeout}" speechTimeout="${g.speechTimeout}" bargeIn="${g.bargeIn}" enhanced="${g.enhanced}" speechModel="${g.speechModel}" method="POST" action="${gatherAction}">
    <Pause length="1"/>
  </Gather>
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
function buildFarewellHangupTwiML(attrs, farewellEscaped, pauseSeconds = 2, innerOverride = null) {
  const pl = Math.max(1, Math.min(4, Number(pauseSeconds) || 2));
  const inner =
    innerOverride ||
    (String(farewellEscaped || "").trim()
      ? `<Say voice="${xmlEscapeAttr(attrs.voice)}" language="${xmlEscapeAttr(attrs.language)}">${farewellEscaped}</Say>
  `
      : "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${inner}<Pause length="${pl}"/>
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
      const greeted = Boolean(callSid && isCallGreeted(callSid));
      const ingested = ingestGatherTurn(callSid, body, { greeted, source: "gather" });
      const { userInput, turn, speech, digits, confidence } = ingested;
      if (ingested.turn?.interim) {
        res.type("text/xml");
        res.send(buildSilentListenTwiML(gatherLoop, callSid));
        console.log("[aura/turn] dropped_interim UnstableSpeechResult callSid=", callSid || "(none)");
        return;
      }
      console.log("CALL SID:", callSid || "(none)");
      console.log(
        "USER INPUT:",
        userInput === WELCOME_SENTINEL ? "(welcome)" : userInput === NO_SPEECH_SENTINEL ? "(no speech)" : userInput,
        confidence != null ? `conf=${confidence}` : "",
        "turn=",
        turn.turnId || "",
        turn.reason || "",
      );

      if (!callSid) {
        console.warn("[aura/flow] MISSING_LEG route=/api/aura/voice reason=no_CallSid_session_not_stored");
      }

      res.type("text/xml");
      const isWelcome = userInput === WELCOME_SENTINEL;
      if (turn.duplicate && turn.replayTwiml) {
        res.send(turn.replayTwiml);
      } else {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${processPath}</Redirect>
</Response>`;
        res.send(xml);
      }
      void speech;
      void digits;
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
      const fromE164 = String(body.From ?? q.From ?? "").trim();
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

      const digitsBody = String(body.Digits ?? "").trim();
      const speechBody = String(body.SpeechResult ?? "").trim();
      const confBody = parseConfidence(body.Confidence ?? body.confidence);
      const twilioEventId = twilioEventIdFromBody(body);
      const eventTurn = twilioEventId ? getTurnByTwilioEvent(callSid, twilioEventId) : null;
      if (eventTurn?.twiml && eventTurn.playback !== "interrupted") {
        res.type("text/xml");
        res.send(eventTurn.twiml);
        sent = true;
        recordTurnTrace(callSid, {
          TURN_ID: eventTurn.turnId,
          TWILIO_EVENT_ID: twilioEventId,
          TRANSCRIPT_HASH: eventTurn.transcriptHash,
          DUPLICATE: true,
          USER_TEXT: eventTurn.userText,
          AURA_RESPONSE_TEXT: eventTurn.reply,
          AUDIO_ID: eventTurn.audioId,
          PLAYBACK_STATE: "replay_same_turn",
          LATENCY_MS: Date.now() - tRoute,
        });
        console.log("[aura/turn] replay_same_turn_event turnId=", eventTurn.turnId);
        return;
      }

      let turn = null;
      if (speechBody || digitsBody) {
        const ingested = ingestGatherTurn(callSid, body, {
          greeted: isCallGreeted(callSid),
          source: "process",
        });
        turn = ingested.turn;
        if (turn?.interim) {
          res.type("text/xml");
          res.send(buildSilentListenTwiML(gatherAction, callSid));
          sent = true;
          return;
        }
        if (turn.duplicate && turn.replayTwiml) {
          res.type("text/xml");
          res.send(turn.replayTwiml);
          sent = true;
          recordTurnTrace(callSid, {
            TURN_ID: turn.turnId,
            TWILIO_EVENT_ID: turn.twilioEventId,
            TRANSCRIPT_HASH: turn.transcriptHash,
            DUPLICATE: true,
            USER_TEXT: ingested.userInput,
            AUDIO_ID: turn.audioId,
            PLAYBACK_STATE: "replay_same_turn",
            LATENCY_MS: Date.now() - tRoute,
          });
          return;
        }
      } else {
        const resolved = resolveTurnInput(callSid, { speech: "", digits: "", turnId: "" });
        turn = resolved.pending?.turnId ? getTurn(callSid, resolved.pending.turnId) : null;
        if (turn?.twiml && turn.playback !== "interrupted") {
          res.type("text/xml");
          res.send(turn.twiml);
          sent = true;
          recordTurnTrace(callSid, {
            TURN_ID: turn.turnId,
            TWILIO_EVENT_ID: turn.twilioEventId,
            TRANSCRIPT_HASH: turn.transcriptHash,
            DUPLICATE: true,
            USER_TEXT: turn.userText,
            AURA_RESPONSE_TEXT: turn.reply,
            AUDIO_ID: turn.audioId,
            PLAYBACK_STATE: "replay_same_turn",
            LATENCY_MS: Date.now() - tRoute,
          });
          console.log("[aura/turn] replay_pending_completed turnId=", turn.turnId);
          return;
        }
      }

      const resolved = resolveTurnInput(callSid, {
        speech: speechBody,
        digits: digitsBody,
        turnId: turn?.turnId || "",
      });
      let userInput = resolved.text;
      const stashed = {
        text: resolved.text,
        meta: {
          confidence: resolved.pending?.confidence ?? confBody,
          bargeInCandidate: Boolean(resolved.pending?.bargeInCandidate),
          turnId: turn?.turnId || resolved.pending?.turnId,
          eventId: turn?.eventId || resolved.pending?.eventId,
          twilioEventId: turn?.twilioEventId || resolved.pending?.twilioEventId,
          transcriptHash: turn?.transcriptHash || resolved.pending?.transcriptHash,
        },
      };
      if (!String(userInput).trim()) {
        userInput = isCallGreeted(callSid) ? NO_SPEECH_SENTINEL : WELCOME_SENTINEL;
        if (!turn) {
          const silence = ingestGatherTurn(callSid, { ...body, SpeechResult: userInput }, {
            greeted: isCallGreeted(callSid),
            source: "silence",
          });
          turn = silence.turn;
          stashed.meta.turnId = turn.turnId;
          stashed.meta.transcriptHash = turn.transcriptHash;
          stashed.meta.twilioEventId = turn.twilioEventId;
        }
      }
      const speechConfidence =
        confBody != null ? confBody : stashed.meta?.confidence != null ? stashed.meta.confidence : null;
      const isWelcome = userInput === WELCOME_SENTINEL;
      const isNoSpeech = userInput === NO_SPEECH_SENTINEL;
      const gate = evaluateSpeechInput({
        callSid,
        speechText: userInput,
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

      if (gate.action === "silent_listen") {
        recordRejectedInput(callSid, { text: userInput, reason: gate.reason });
        res.type("text/xml");
        res.send(buildSilentListenTwiML(gatherAction, callSid));
        sent = true;
        recordVoiceTiming({
          speechToResponseMs: Date.now() - tRoute,
          responseGenerationMs: gate.metrics?.gateMs ?? Date.now() - tRoute,
          totalTurnMs: Date.now() - tRoute,
        });
        console.log("[aura/noise] silent_listen", gate.reason, "noisy=", gate.noisyMode);
        return;
      }

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
        language = resolveVoiceReplyLang(userInput, getCallLanguage(callSid), language);
        if (callSid) setCallLanguage(callSid, language);
        const attrs = twilioSayAttributes(language, voiceType);
        const prompt = escapeTwilioSayText(String(gate.prompt || "Could you please repeat that?"));
        const stillHere = escapeTwilioSayText("I'm still here if you need me.");
        rememberAssistantSpeech(callSid, gate.prompt || "");
        recordAuraTurn(callSid, { turnId: stashed.meta?.turnId, text: gate.prompt || "" });
        const gatedMain = await voiceboxOrPollyUtterance(attrs, gate.prompt || "", prompt, { callSid, language, from: fromE164 });
        const gatedXml = buildVoiceLoopTwiML(
          gatherAction,
          attrs,
          gatedMain.xml,
          utteranceXml(attrs, stillHere, null),
          callSid,
        );
        rememberReplay(callSid, {
          turnId: stashed.meta?.turnId,
          twiml: gatedXml,
          reply: gate.prompt || "",
          audioId: gatedMain.audioId,
        });
        recordTurnTrace(callSid, {
          TURN_ID: stashed.meta?.turnId,
          TWILIO_EVENT_ID: stashed.meta?.twilioEventId || twilioEventId,
          TRANSCRIPT_HASH: stashed.meta?.transcriptHash,
          DUPLICATE: false,
          USER_TEXT: userInput,
          INTENT: gate.reason,
          AURA_RESPONSE_TEXT: gate.prompt || "",
          AUDIO_ID: gatedMain.audioId,
          PLAYBACK_STATE: "playing",
          LATENCY_MS: Date.now() - tRoute,
        });
        res.type("text/xml");
        res.send(gatedXml);
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
      language = resolveVoiceReplyLang(userInput, getCallLanguage(callSid), language);
      if (callSid) setCallLanguage(callSid, language);
      console.log("[aura/timing] /api/aura/process_settings_ms", Date.now() - tSettings);

      const attrs = twilioSayAttributes(language, voiceType);
      const turnId = stashed.meta?.turnId || turn?.turnId || "";

      const produced = await runExclusiveTurn(callSid || `anon_${tRoute}`, async () => {
        const already = turnId ? getTurn(callSid, turnId) : null;
        if (already?.twiml && already.playback !== "interrupted") {
          return { kind: "ready", twiml: already.twiml, reply: already.reply, audioId: already.audioId, duplicate: true };
        }

        if (isAuraVoiceIntelligencePhase1()) {
          try {
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
              const guarded = applyRepeatGuard(callSid, String(intel.reply).trim(), { userText: userInput });
              const spoken = guarded.reply;
              const closingSay = escapeTwilioSayText(spoken);
              const inner = await voiceboxOrPollyUtterance(attrs, spoken, closingSay, {
                callSid,
                language,
                from: fromE164,
                audioId: already?.audioId,
              });
              if (intel.afterBookingClose || intel.hangup) {
                const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${inner.xml}
  <Hangup/>
</Response>`;
                rememberReplay(callSid, { turnId, twiml: xml, reply: spoken, audioId: inner.audioId });
                return { kind: "ready", twiml: xml, reply: spoken, audioId: inner.audioId, hangup: true, intent: intel.intent };
              }
              rememberAssistantSpeech(callSid, spoken);
              recordAuraTurn(callSid, { turnId, text: spoken, audioId: inner.audioId });
              const stillHere = escapeTwilioSayText("I'm still here if you need me.");
              const xml = buildVoiceLoopTwiML(
                gatherAction,
                attrs,
                inner.xml,
                utteranceXml(attrs, stillHere, null),
                callSid,
              );
              rememberReplay(callSid, { turnId, twiml: xml, reply: spoken, audioId: inner.audioId });
              markPlaybackSpeaking(callSid, true, inner.audioId);
              return { kind: "ready", twiml: xml, reply: spoken, audioId: inner.audioId, intent: intel.intent };
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

        if (bookingOut.duplicateExecutionBlocked) {
          const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
          return { kind: "ready", twiml: xml, reply: "", hangup: true, bookingOut };
        }
        if (bookingOut.afterBookingClose) {
          const L = normalizeBarberLang(language);
          const closingText =
            L === "es"
              ? "Todo listo. Tu cita está confirmada. Gracias por elegir IFCDC."
              : "You're all set. Your appointment has been confirmed. Thank you for choosing IFCDC.";
          const inner = await voiceboxOrPollyUtterance(attrs, closingText, escapeTwilioSayText(closingText), {
            callSid,
            language,
            from: fromE164,
          });
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${inner.xml}
  <Hangup/>
</Response>`;
          rememberReplay(callSid, { turnId, twiml: xml, reply: closingText, audioId: inner.audioId });
          return { kind: "ready", twiml: xml, reply: closingText, audioId: inner.audioId, hangup: true, bookingOut };
        }
        if (bookingOut.hangupFollowup) {
          const farewellRaw = String(bookingOut.reply ?? "").trim();
          const inner = await voiceboxOrPollyUtterance(attrs, farewellRaw, escapeTwilioSayText(farewellRaw), {
            callSid,
            language,
            from: fromE164,
          });
          const xml = buildFarewellHangupTwiML(attrs, escapeTwilioSayText(farewellRaw), 2, inner.xml);
          rememberReplay(callSid, { turnId, twiml: xml, reply: farewellRaw, audioId: inner.audioId });
          return { kind: "ready", twiml: xml, reply: farewellRaw, audioId: inner.audioId, hangup: true, bookingOut };
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
              ? "Estoy aquí. ¿Cómo puedo ayudarte hoy?"
              : "I'm here. How can I help you today?";
        }
        const guardedBook = applyRepeatGuard(callSid, reply, { userText: userInput });
        reply = guardedBook.reply;
        const inner = await voiceboxOrPollyUtterance(attrs, reply, escapeTwilioSayText(reply), {
          callSid,
          language,
          from: fromE164,
          audioId: already?.audioId,
        });
        const stillHere = escapeTwilioSayText(
          normalizeBarberLang(language) === "es" ? "Sigo aquí si me necesitas." : "I'm still here if you need me.",
        );
        rememberAssistantSpeech(callSid, reply);
        recordAuraTurn(callSid, { turnId, text: reply, audioId: inner.audioId });
        markPlaybackSpeaking(callSid, true, inner.audioId);
        const xml = buildVoiceLoopTwiML(
          gatherAction,
          attrs,
          inner.xml,
          utteranceXml(attrs, stillHere, null),
          callSid,
        );
        rememberReplay(callSid, { turnId, twiml: xml, reply, audioId: inner.audioId });
        return {
          kind: "ready",
          twiml: xml,
          reply,
          audioId: inner.audioId,
          bookingOut,
          suppressed: guardedBook.suppressed,
        };
      });

      res.type("text/xml");
      if (produced?.hangup && produced.bookingOut?.afterBookingClose) {
        markCallCompleted(callSid);
        if (req.session) req.session.bookingCompleted = true;
      }
      if (produced?.hangup && produced.bookingOut?.duplicateExecutionBlocked) {
        markCallCompleted(callSid);
      }
      res.send(produced.twiml);
      sent = true;
      recordVoiceTiming({
        speechToResponseMs: Date.now() - tRoute,
        responseGenerationMs: Date.now() - tRoute,
        totalTurnMs: Date.now() - tRoute,
      });
      recordTurnTrace(callSid, {
        TURN_ID: turnId,
        TWILIO_EVENT_ID: stashed.meta?.twilioEventId || twilioEventId,
        TRANSCRIPT_FINAL: true,
        TRANSCRIPT_HASH: stashed.meta?.transcriptHash || "",
        DUPLICATE: Boolean(produced?.duplicate),
        USER_TEXT: userInput,
        INTENT: produced?.intent || produced?.bookingOut?.bookingLog || snapshotLedger(callSid).currentIntent || "",
        CONTEXT_SUMMARY: contextSummary(callSid),
        AURA_RESPONSE_TEXT: produced?.reply || "",
        AUDIO_ID: produced?.audioId || "",
        PLAYBACK_STATE: produced?.hangup ? "hangup" : "playing",
        LATENCY_MS: Date.now() - tRoute,
      });
      console.log("STAGE:", produced?.bookingOut?.stage || "", produced?.bookingOut?.bookingLog || "");
      console.log("REPLY:", String(produced?.reply || "").slice(0, 400));
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
