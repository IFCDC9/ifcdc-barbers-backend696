/**
 * Twilio Voice + SMS webhooks for Phone AURA.
 * Always returns valid TwiML / never empty responses on voice; SMS always returns <Message>.
 */
import twilio from "twilio";
import { createRequire } from "node:module";
import { auraStructuredIntentFromKeywords, auraKeywordFallbackReply, auraVoiceIntentFromSpeech } from "./auraIntent.js";
import { insertAuraVoiceBookingRow } from "./bookingsRoutes.js";
import { auraFetchStyleTitles } from "./auraData.js";
import { assertTwilioWebhookSignature } from "./auraTwilioSecurity.js";
import { loadBarberSettingsRow } from "./barberScope.js";
import {
  chatKeywordReply,
  normalizeBarberLang,
  smsBookedDoneLine,
  smsBookOpenWithStyleAsk,
  smsConfirmPrompt,
  smsFatalError,
  smsStartOver,
  smsTryAgain,
  smsWhatDay,
  smsWhatTime,
  smsWhoWouldYouLike,
  tVoice,
  twilioSayAttributes,
  voiceGeneralClarify,
  voiceSmsAppointmentLine,
  voiceTimeLineTomorrow,
} from "./auraLocale.js";
import {
  isSsmlSpeakFragment,
  ssmlBookingConfirmedCompleteHangup,
  ssmlSpeakPlain,
  ssmlThanksCallingOpener,
} from "./auraVoiceSsml.js";
import {
  VoiceState,
  createVoiceBookingMachineState,
  extract10DigitUsPhone,
  formatUsPhoneDash10,
} from "./auraVoiceBookingMachine.js";
import { createSimpleAuraVoiceHandlers } from "./auraVoiceReply.js";

const require = createRequire(import.meta.url);

const FAILSAFE =
  "I'm right here—just tell me what you need. You can say book, styles, or ask a question.";

/** E.164 — primary admin SMS for AURA voice booking notifications. */
const AURA_ADMIN_NOTIFY_E164 = "+17327435048";

/** Cached style titles — SMS + style picker; refreshed in background. */
let styleTitlesCache = [];
function refreshStyleTitlesCache() {
  auraFetchStyleTitles(60)
    .then((rows) => {
      styleTitlesCache = Array.isArray(rows) ? rows : [];
    })
    .catch(() => {
      /* keep previous cache */
    });
}

let _styleCacheIntervalStarted = false;
function startStyleTitlesCacheRefreshLoop() {
  if (_styleCacheIntervalStarted) return;
  _styleCacheIntervalStarted = true;
  refreshStyleTitlesCache();
  setInterval(refreshStyleTitlesCache, 5 * 60 * 1000);
}

/** @type {Map<string, Record<string, unknown>>} */
const auraSmsSessions = new Map();

/**
 * Voice booking wizard (Twilio does not send cookies on webhooks — key by CallSid).
 * @type {Map<string, Record<string, unknown>>}
 */
const auraVoiceBookingState = new Map();

const VOICE_BOOKING_CAP = 2000;

const MAX_STATE_TRY = 2;

function getVoiceBookingState(callSid) {
  const key = String(callSid || "").trim() || "_local_";
  while (auraVoiceBookingState.size >= VOICE_BOOKING_CAP) {
    const first = auraVoiceBookingState.keys().next().value;
    if (first === undefined) break;
    auraVoiceBookingState.delete(first);
  }
  if (!auraVoiceBookingState.has(key)) {
    auraVoiceBookingState.set(key, createVoiceBookingMachineState());
  } else {
    const cur = auraVoiceBookingState.get(key);
    if (cur && cur.step != null && cur.machineState == null) {
      auraVoiceBookingState.set(key, createVoiceBookingMachineState());
    }
  }
  return auraVoiceBookingState.get(key);
}

function clearVoiceBookingState(callSid) {
  auraVoiceBookingState.delete(String(callSid || "").trim() || "_local_");
}

function ymdToday() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function ymdTomorrow() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function normalizeDigitsToE164(digits, fallbackFromE164) {
  const raw = String(digits || "").replace(/\D/g, "");
  if (raw.length >= 10) {
    const ten = raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw.slice(-10);
    return `+1${ten}`;
  }
  const fb = String(fallbackFromE164 || "").trim();
  return fb && fb.startsWith("+") ? fb : "";
}

function callerIdAvailableForSms(from) {
  const p = String(from || "").trim();
  if (!p) return false;
  if (/^anonymous$/i.test(p)) return false;
  if (/^(unknown|restricted|private|unavailable)$/i.test(p)) return false;
  const d = p.replace(/\D/g, "");
  return d.length >= 10;
}

function callerE164FromTwilioFrom(from) {
  if (!callerIdAvailableForSms(from)) return "";
  return normalizeDigitsToE164(String(from).replace(/\D/g, ""), from);
}

function isNo(speech) {
  return /\b(no|nah|nope|nothing|that'?s all|all set|i'?m good|im good|done)\b/i.test(String(speech || ""));
}

function twimlSms(messageText) {
  const t = String(messageText || "").trim() || "Thanks for texting Imperial Foundation CDC Barbers.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(t)}</Message></Response>`;
}

function pickStyleTitleFromSpeechSync(speech) {
  const raw = String(speech || "").trim();
  const titles = styleTitlesCache || [];
  const s = raw.toLowerCase();
  for (const t of titles) {
    if (s.includes(String(t).toLowerCase())) return t;
  }
  const hints = ["fade", "taper", "beard", "lineup", "buzz", "afro", "kid"];
  for (const w of hints) {
    if (new RegExp(`\\b${w}\\b`).test(s)) {
      const hit = titles.find((x) => String(x).toLowerCase().includes(w));
      if (hit) return hit;
    }
  }
  if (raw) return raw.slice(0, 80);
  return "Haircut";
}

function sendSmsXml(res, messageText) {
  try {
    if (res.headersSent) return;
    res.type("text/xml");
    res.send(twimlSms(messageText));
  } catch (sendErr) {
    console.error("[aura/sms] sendSmsXml failed:", sendErr?.stack || sendErr);
  }
}

const FALLBACK_BARBERS = [
  { id: 1, name: "Fade Master" },
  { id: 2, name: "Clipper King" },
];

function getBarbersInMemory() {
  try {
    if (Array.isArray(global.barbers) && global.barbers.length) return global.barbers;
  } catch {
    /* ignore */
  }
  return FALLBACK_BARBERS;
}

function coerceBarberId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 1;
}

function pickDefaultBarber() {
  const list = getBarbersInMemory();
  const first = list[0];
  if (!first) return { id: 1, name: "Any stylist" };
  return {
    id: coerceBarberId(first.id),
    name: String(first.name || "Stylist").trim() || "Stylist",
  };
}

function matchBarberFromSpeech(speech) {
  const s = String(speech || "").toLowerCase().trim();
  if (!s || /\b(any|whoever|skip|no preference|doesn'?t matter)\b/.test(s)) {
    return pickDefaultBarber();
  }
  const list = getBarbersInMemory();
  const sorted = [...list].sort((a, b) => String(b.name || "").length - String(a.name || "").length);
  for (const b of sorted) {
    const n = String(b.name || "").trim();
    if (!n) continue;
    const nl = n.toLowerCase();
    if (s.includes(nl)) return { id: coerceBarberId(b.id), name: n };
    const first = nl.split(/\s+/)[0];
    if (first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(s)) {
      return { id: coerceBarberId(b.id), name: n };
    }
  }
  return pickDefaultBarber();
}

function parseDateFromSpeech(speech) {
  const lower = String(speech || "").toLowerCase();
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (/\btomorrow\b/.test(lower)) d.setDate(d.getDate() + 1);
  else if (/\bnext week\b/.test(lower)) d.setDate(d.getDate() + 7);
  else if (/\btoday\b/.test(lower)) {
    /* keep */
  } else {
    const iso = String(speech || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
    return "";
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatClockDisplay(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  const mm = String(min).padStart(2, "0");
  return min === 0 ? `${h12} ${ap}` : `${h12}:${mm} ${ap}`;
}

function inferServiceFromSpeech(raw) {
  const s = String(raw || "").toLowerCase();
  if (/\bfade\b/.test(s)) return "Fade";
  if (/\bbeard\b/.test(s)) return "Beard trim";
  if (/\blineup\b/.test(s)) return "Lineup";
  if (/\btaper\b/.test(s)) return "Taper";
  return "Haircut";
}

function parseTimeFromSpeech(speech) {
  const lower = String(speech || "").toLowerCase();
  let raw = "";
  const ampm = String(speech || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const mi = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const ap = String(ampm[3]).toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    raw = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  } else if (/\b(morning)\b/.test(lower)) raw = "09:30";
  else if (/\b(noon)\b/.test(lower)) raw = "12:00";
  else if (/\b(afternoon)\b/.test(lower)) raw = "14:00";
  else if (/\b(evening)\b/.test(lower)) raw = "17:00";
  else {
    const t24 = String(speech || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (t24) raw = `${String(t24[1]).padStart(2, "0")}:${t24[2]}`;
  }
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  let h = Number(m[1]);
  let min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return "";
  h = Math.max(0, Math.min(23, h));
  min = Math.max(0, Math.min(59, min));
  const total = h * 60 + min;
  const snapped = Math.round(total / 30) * 30;
  const nh = Math.floor(snapped / 60) % 24;
  const nm = snapped % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function inferTimeSlotFromSpeech(inputRaw) {
  const lower = String(inputRaw || "").toLowerCase();
  if (/\b(morning|early)\b/.test(lower) && !/\b(afternoon|evening)\b/.test(lower)) {
    return { timeStr: "10:00", timeDisplay: "10 AM" };
  }
  if (/\b(afternoon|after lunch|mid-?afternoon)\b/.test(lower)) {
    return { timeStr: "14:00", timeDisplay: "2 PM" };
  }
  if (/\b(evening|after work|late day)\b/.test(lower)) {
    return { timeStr: "17:00", timeDisplay: "5 PM" };
  }
  const t = parseTimeFromSpeech(inputRaw);
  if (t) return { timeStr: t, timeDisplay: formatClockDisplay(t) };
  if (/\b(two|2)\b/.test(lower) && /\b(pm|afternoon)\b/.test(lower)) return { timeStr: "14:00", timeDisplay: "2 PM" };
  if (/\b(four|4)\b/.test(lower) && /\b(pm|afternoon)\b/.test(lower)) return { timeStr: "16:00", timeDisplay: "4 PM" };
  if (/\b(three|3)\b/.test(lower) && /\b(thirty|:30)\b/.test(lower)) return { timeStr: "15:00", timeDisplay: "3 PM" };
  const bare = String(inputRaw || "").trim().match(/^(2|4|two|four)$/i);
  if (bare) {
    const d = bare[1].toLowerCase();
    if (d === "2" || d === "two") return { timeStr: "14:00", timeDisplay: "2 PM" };
    if (d === "4" || d === "four") return { timeStr: "16:00", timeDisplay: "4 PM" };
  }
  return null;
}

function isYes(speech) {
  return /\b(yes|yeah|yep|sure|confirm|book it|please|correct|right|si|sí|claro|dale|ok)\b/iu.test(String(speech || ""));
}

/**
 * @param {import("express").Application} app
 * @param {{ insertVoiceRow?: (body: object) => Promise<object> }} [opts]
 */
export function attachAuraVoiceRoutes(app, opts = {}) {
  const insertVoiceRow = opts.insertVoiceRow;
  startStyleTitlesCacheRefreshLoop();

  // Core call stability handler: always returns TwiML immediately.
  const voiceHandler = async (req, res) => {
    res.set("Content-Type", "text/xml");

    console.log("🚀 AURA WEBHOOK HIT", { mode: "wizard", method: String(req.method || "").toUpperCase() });
    console.log("📞 Incoming call:", req.body);

    if (String(process.env.AURA_VOICE_DIAGNOSTIC || "").trim() === "1") {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("AURA is connected.");
      return res.send(twiml.toString());
    }

    let responded = false;
    const safeSend = (xml) => {
      if (responded || res.headersSent) return;
      responded = true;
      res.send(xml);
    };

    const body = req.body && typeof req.body === "object" ? req.body : {};
    let sayAttrs = twilioSayAttributes("en", "Polly.Joanna");
    let L = "en";
    try {
      const bid = Number(process.env.VOICE_DEFAULT_BARBER_LANGUAGE_ID || "1") || 1;
      const st = await loadBarberSettingsRow(bid);
      sayAttrs = twilioSayAttributes(st.language, st.aura_voice_type);
      L = normalizeBarberLang(st.language);
    } catch (e) {
      console.warn("[aura/voice] settings load:", e?.message || e);
    }

    const voiceSayXml = (messageOrSsml) => {
      const inner = isSsmlSpeakFragment(messageOrSsml) ? String(messageOrSsml).trim() : ssmlSpeakPlain(messageOrSsml);
      return `<Say voice="${xmlEscape(sayAttrs.voice)}" language="${xmlEscape(sayAttrs.language)}">${inner}</Say>`;
    };

    // Hard failsafe: never let Twilio wait > ~1.5s.
    const timer = setTimeout(() => {
      safeSend(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(tVoice(L, "reconnect"))}
  <Redirect method="POST">/api/aura/voice</Redirect>
</Response>`);
    }, 1500);

    // Optional wiring test: return instant TwiML without running any booking logic.
    if (String(process.env.AURA_VOICE_TEST_RESPONSE || "").trim() === "1") {
      clearTimeout(timer);
      safeSend(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>AURA is connected successfully.</Say>
</Response>`);
      return;
    }

    console.log("AURA HIT:", req.body);

    // NOTE: We don't early-return on missing SpeechResult/Digits here because later stateful
    // branches (e.g. DTMF collection timeouts) must still run and return TwiML.

    try {
      // Capture caller phone for later use (no async here).
      const callSid = String(body.CallSid || "").trim();
      const s = getVoiceBookingState(callSid);
      const phone = String(body.From || "").trim();
      if (phone && req.session && typeof req.session === "object") {
        req.session.phone = phone;
      }

      const inputRaw = String(body.SpeechResult || "").trim();
      const input = inputRaw.toLowerCase();
      console.log("AURA INPUT:", inputRaw || "(none)");

      const respond = (message) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(message)}
  <Gather input="speech" timeout="6" speechTimeout="auto" action="/api/aura/voice" method="POST"></Gather>
  <Redirect method="POST">/api/aura/voice</Redirect>
</Response>`;

      const respondFinal = (message) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(message)}
  <Pause length="2"/>
</Response>`;

      const respondGatherDigits = (sayMessage, opts2 = {}) => {
        const timeout = Number(opts2.timeout ?? 5);
        const finishOnKey = String(opts2.finishOnKey ?? "#");
        const nd = opts2.numDigits;
        const hasNd = nd != null && nd !== "" && Number.isFinite(Number(nd));
        const gatherAttrs = [`input="dtmf"`, `timeout="${timeout}"`, `action="/api/aura/voice"`, `method="POST"`];
        if (hasNd) gatherAttrs.push(`numDigits="${Number(nd)}"`);
        else gatherAttrs.push(`finishOnKey="${xmlEscape(finishOnKey)}"`);
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(sayMessage)}
  <Gather ${gatherAttrs.join(" ")}></Gather>
</Response>`;
      };

      const respondKeypadNl = () => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(tVoice(L, "keypad_intro"))}
  <Gather input="dtmf" numDigits="1" timeout="5" action="/api/aura/voice" method="POST"></Gather>
</Response>`;

      const rememberVoice = (line, intent) => {
        s.lastUserLine = String(line || "").slice(0, 220);
        s.lastIntent = String(intent || "");
        if (!Array.isArray(s.voiceHistory)) s.voiceHistory = [];
        s.voiceHistory.push({ intent: s.lastIntent, line: s.lastUserLine });
        if (s.voiceHistory.length > 8) s.voiceHistory.shift();
      };

      const respondHangup = (messageOrSsml) => {
        const inner = isSsmlSpeakFragment(messageOrSsml) ? String(messageOrSsml).trim() : ssmlSpeakPlain(messageOrSsml);
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${xmlEscape(sayAttrs.voice)}" language="${xmlEscape(sayAttrs.language)}">${inner}</Say>
  <Hangup/>
</Response>`;
      };

      const retryGate = () => {
        switch (s.machineState) {
          case VoiceState.SERVICE_SELECTION:
            return "service";
          case VoiceState.TIME_SELECTION:
            return s.timePhase === "pick_name" ? "name" : "time";
          case VoiceState.PHONE_CAPTURE:
            return s.phonePhase === "confirm" ? "phoneConfirm" : "phone";
          case VoiceState.CONFIRMATION:
            return "final";
          default:
            return "idle";
        }
      };

      const bumpRetryGate = () => {
        const g = retryGate();
        s.retry[g] = Number(s.retry[g] || 0) + 1;
        return s.retry[g];
      };

      const resetRetryGate = () => {
        const g = retryGate();
        s.retry[g] = 0;
      };

      const overRetry = () => Number(s.retry[retryGate()] || 0) >= MAX_STATE_TRY;

      const hangMaxRetries = () => {
        clearVoiceBookingState(callSid);
        return safeSend(respondHangup(ssmlSpeakPlain(tVoice(L, "voice_max_retries_goodbye"))));
      };

      const finalizeVoiceBookingAndNotify = async (explicitE164) => {
        if (s.closeoutFinalized) return { ok: true };
        s.closeoutFinalized = true;

        const sendSms = undefined;
        const customerMsg = tVoice(L, "customer_sms_thanks");
        const ts = new Date().toISOString();
        const customerE164 = String(explicitE164 || "").trim();
        const callerDisplay = customerE164 || (callerIdAvailableForSms(phone) ? phone : "(unavailable)");
        const timeLine = voiceTimeLineTomorrow(L, s.timeDisplay);

        const adminMsg = [
          "Imperial Foundation CDC voice booking",
          `Name: ${String(s.name || "—").trim()}`,
          `Requested service: ${String(s.service || "Haircut").trim()}`,
          `Requested time: ${timeLine}`,
          `Caller phone: ${callerDisplay}`,
          `Timestamp: ${ts}`,
        ].join("\n");

        const digits10 = customerE164.replace(/\D/g, "").slice(-10) || "unknown";
        const guestEmail =
          String(process.env.VOICE_DEFAULT_CUSTOMER_EMAIL || "").trim() ||
          `voice.${digits10 || "caller"}.${Date.now()}@ifcdc-voice.placeholder`;

        const bookBody = {
          channel: "aura_voice",
          name: String(s.name || "AURA Caller").trim() || "AURA Caller",
          email: guestEmail,
          phone: customerE164 || null,
          date: ymdTomorrow(),
          time: s.timeStr || "14:00",
          barberId: 1,
          barber: "Any barber",
          service: String(s.service || "Haircut").trim() || "Haircut",
          callSid: callSid || `voice_${Date.now()}`,
        };

        if (typeof insertVoiceRow === "function") {
          try {
            await insertVoiceRow(bookBody);
          } catch (e) {
            console.error("[aura/voice] insertVoiceRow failed:", e?.stack || e);
            return { ok: false, error: e };
          }
        }

        const timeoutMs = 1200;
        const raceSend = (to, body) => {
          if (!to || typeof sendSms !== "function") return;
          Promise.race([Promise.resolve(sendSms(body, to)), new Promise((r) => setTimeout(r, timeoutMs))]).catch(() => {});
        };

        if (customerE164) raceSend(customerE164, customerMsg);
        raceSend(AURA_ADMIN_NOTIFY_E164, adminMsg);
        return { ok: true };
      };

      const wantsText =
        input.includes("text") ||
        input.includes("confirmation text") ||
        input.includes("send me a text") ||
        input.includes("send confirmation") ||
        input.includes("text me");

      clearTimeout(timer);

      const dtmfDigits = String(body.Digits || "").trim();

      if (s.machineState === VoiceState.COMPLETED) {
        return safeSend(respondHangup(ssmlBookingConfirmedCompleteHangup(L)));
      }

      /* ---- GREETING: one-time opener, then SERVICE_SELECTION ---- */
      if (s.machineState === VoiceState.GREETING) {
        s.machineState = VoiceState.SERVICE_SELECTION;
        if (!inputRaw && !dtmfDigits) {
          s.retry.service = 0;
          return safeSend(respond(ssmlThanksCallingOpener(L)));
        }
      }

      /* ---- PHONE_CAPTURE: 10-digit keypad entry ---- */
      if (s.machineState === VoiceState.PHONE_CAPTURE && s.phonePhase === "entry" && dtmfDigits) {
        const ten = extract10DigitUsPhone(dtmfDigits);
        if (ten.length === 10) {
          s.pendingPhone10 = ten;
          s.phonePhase = "confirm";
          resetRetryGate();
          const read = tVoice(L, "voice_phone_readback").replace("{phone}", formatUsPhoneDash10(ten));
          return safeSend(respond(ssmlSpeakPlain(read)));
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        return safeSend(
          respondGatherDigits(ssmlSpeakPlain(tVoice(L, "voice_phone_enter_10")), { timeout: 12, numDigits: 10 }),
        );
      }

      /* ---- TIME_SELECTION: keypad branch (DTMF) ---- */
      if (s.machineState === VoiceState.TIME_SELECTION && s.timeKeypad) {
        if (!dtmfDigits) {
          s.chooseTimeFails = 0;
          s.timeKeypad = false;
          s.timePhase = "pick_time";
          return safeSend(respond(tVoice(L, "time_feels_right")));
        }
        const d = dtmfDigits.slice(0, 1);
        let picked = null;
        if (d === "1") picked = { timeStr: "10:00", timeDisplay: "10 AM" };
        if (d === "2") picked = { timeStr: "14:00", timeDisplay: "2 PM" };
        if (d === "3") picked = { timeStr: "17:00", timeDisplay: "5 PM" };
        if (!picked) {
          bumpRetryGate();
          if (overRetry()) return hangMaxRetries();
          return safeSend(respond(tVoice(L, "time_keypad_reprompt")));
        }
        s.timeKeypad = false;
        s.timeStr = picked.timeStr;
        s.timeDisplay = picked.timeDisplay;
        s.timePhase = "pick_name";
        s.chooseTimeFails = 0;
        resetRetryGate();
        if (req.session && typeof req.session === "object") {
          req.session.time = `tomorrow at ${picked.timeDisplay}`;
        }
        return safeSend(respond(tVoice(L, "locked_timing_name")));
      }

      /* ---- SERVICE_SELECTION: keypad (optional) ---- */
      if (s.machineState === VoiceState.SERVICE_SELECTION && s.keypadActive) {
        if (!dtmfDigits) {
          if (Number(s.nlKeypadRetries || 0) >= 1) {
            s.keypadActive = false;
            s.nlKeypadRetries = 0;
            bumpRetryGate();
            if (overRetry()) return hangMaxRetries();
            return safeSend(respond(ssmlSpeakPlain(tVoice(L, "voice_service_prompt"))));
          }
          s.nlKeypadRetries = Number(s.nlKeypadRetries || 0) + 1;
          return safeSend(respondKeypadNl());
        }
        const d = dtmfDigits.slice(0, 1);
        s.nlKeypadRetries = 0;
        s.idleConfuse = 0;
        if (d === "1") {
          s.service = "Haircut";
          s.keypadActive = false;
          s.machineState = VoiceState.TIME_SELECTION;
          s.timePhase = "pick_time";
          s.timeKeypad = false;
          s.chooseTimeFails = 0;
          resetRetryGate();
          return safeSend(respond(tVoice(L, "time_tomorrow_question")));
        }
        if (d === "2") {
          const hrs = auraVoiceIntentFromSpeech("what are your hours", L);
          return safeSend(respond(hrs.reply));
        }
        if (d === "3") {
          const pr = auraVoiceIntentFromSpeech("how much is a haircut", L);
          return safeSend(respond(pr.reply));
        }
        return safeSend(respondKeypadNl());
      }

      /* ---- Empty speech + no DTMF (silence / timeout) ---- */
      if (!inputRaw && !dtmfDigits) {
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        if (s.machineState === VoiceState.SERVICE_SELECTION) {
          if (s.keypadActive) return safeSend(respondKeypadNl());
          return safeSend(respond(ssmlSpeakPlain(tVoice(L, "voice_service_prompt"))));
        }
        if (s.machineState === VoiceState.TIME_SELECTION) {
          if (s.timeKeypad) {
            return safeSend(respondGatherDigits(tVoice(L, "time_keypad_prompt"), { timeout: 5, numDigits: 1 }));
          }
          if (s.timePhase === "pick_name") return safeSend(respond(tVoice(L, "listening_booking")));
          return safeSend(respond(tVoice(L, "time_check_prompt")));
        }
        if (s.machineState === VoiceState.PHONE_CAPTURE) {
          if (s.phonePhase === "confirm") return safeSend(respond(ssmlSpeakPlain(tVoice(L, "voice_phone_readback").replace("{phone}", formatUsPhoneDash10(s.pendingPhone10)))));
          return safeSend(
            respondGatherDigits(ssmlSpeakPlain(tVoice(L, "voice_phone_enter_10")), { timeout: 12, numDigits: 10 }),
          );
        }
        if (s.machineState === VoiceState.CONFIRMATION) {
          const when = s.timeDisplay ? `tomorrow at ${s.timeDisplay}` : "tomorrow";
          const summary = `${s.service || "Haircut"} ${when}, ${s.name || "guest"}. ${tVoice(L, "voice_final_confirm_suffix")}`;
          return safeSend(respond(ssmlSpeakPlain(summary)));
        }
        return safeSend(respond(tVoice(L, "listening_idle")));
      }

      if (wantsText && req.session && typeof req.session === "object" && req.session.phone) {
        const sendSms = undefined;
        const toPhone = String(req.session.phone || "").trim();
        const when = String(req.session.time || s.timeDisplay || "tomorrow at 2 PM").trim();
        if (typeof sendSms === "function" && toPhone) {
          const smsBody = voiceSmsAppointmentLine(L, when);
          const timeoutMs = 1200;
          Promise.race([
            Promise.resolve(sendSms(smsBody, toPhone)),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
          ]).catch(() => {});
        }
        return safeSend(respondFinal(tVoice(L, "confirmation_sent")));
      }

      /* ---- CONFIRMATION: final yes saves booking and hangs up ---- */
      if (s.machineState === VoiceState.CONFIRMATION) {
        if (isYes(inputRaw)) {
          const e164 = normalizeDigitsToE164(s.phoneDigits10, "");
          if (!e164 || e164.length < 12) {
            clearVoiceBookingState(callSid);
            return safeSend(respondHangup(ssmlSpeakPlain(tVoice(L, "voice_max_retries_goodbye"))));
          }
          const r = await finalizeVoiceBookingAndNotify(e164);
          if (!r?.ok) {
            clearVoiceBookingState(callSid);
            return safeSend(respondHangup(ssmlSpeakPlain(tVoice(L, "voice_max_retries_goodbye"))));
          }
          s.machineState = VoiceState.COMPLETED;
          clearVoiceBookingState(callSid);
          return safeSend(respondHangup(ssmlBookingConfirmedCompleteHangup(L)));
        }
        if (isNo(inputRaw)) {
          return hangMaxRetries();
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        const when = s.timeDisplay ? `tomorrow at ${s.timeDisplay}` : "tomorrow";
        const summary = `${s.service || "Haircut"} ${when}, ${s.name || "guest"}. ${tVoice(L, "voice_final_confirm_suffix")}`;
        return safeSend(respond(ssmlSpeakPlain(summary)));
      }

      /* ---- PHONE_CAPTURE: confirm readback (speech) ---- */
      if (s.machineState === VoiceState.PHONE_CAPTURE && s.phonePhase === "confirm" && inputRaw) {
        if (isYes(inputRaw)) {
          s.phoneDigits10 = String(s.pendingPhone10 || "").replace(/\D/g, "");
          s.pendingPhone10 = "";
          s.machineState = VoiceState.CONFIRMATION;
          s.retry.final = 0;
          resetRetryGate();
          const when = s.timeDisplay ? `tomorrow at ${s.timeDisplay}` : "tomorrow";
          const summary = `${s.service || "Haircut"} ${when}, ${s.name || "guest"}. ${tVoice(L, "voice_final_confirm_suffix")}`;
          return safeSend(respond(ssmlSpeakPlain(summary)));
        }
        if (isNo(inputRaw)) {
          s.phonePhase = "entry";
          s.pendingPhone10 = "";
          bumpRetryGate();
          if (overRetry()) return hangMaxRetries();
          return safeSend(
            respondGatherDigits(ssmlSpeakPlain(tVoice(L, "voice_phone_enter_10")), { timeout: 12, numDigits: 10 }),
          );
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        const read = tVoice(L, "voice_phone_readback").replace("{phone}", formatUsPhoneDash10(s.pendingPhone10));
        return safeSend(respond(ssmlSpeakPlain(read)));
      }

      /* ---- PHONE_CAPTURE: speech entry (10 digits) ---- */
      if (s.machineState === VoiceState.PHONE_CAPTURE && s.phonePhase === "entry" && inputRaw) {
        const ten = extract10DigitUsPhone(inputRaw);
        if (ten.length === 10) {
          s.pendingPhone10 = ten;
          s.phonePhase = "confirm";
          resetRetryGate();
          const read = tVoice(L, "voice_phone_readback").replace("{phone}", formatUsPhoneDash10(ten));
          return safeSend(respond(ssmlSpeakPlain(read)));
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        return safeSend(
          respondGatherDigits(ssmlSpeakPlain(tVoice(L, "voice_phone_enter_10")), { timeout: 12, numDigits: 10 }),
        );
      }

      /* ---- TIME_SELECTION: name then advance to phone ---- */
      if (s.machineState === VoiceState.TIME_SELECTION && s.timePhase === "pick_name" && inputRaw) {
        const cleanedName = inputRaw.replace(/\s+/g, " ").trim().slice(0, 80);
        const looksLikeName =
          /[a-z]/i.test(cleanedName) &&
          cleanedName.length >= 2 &&
          !/\b(am|pm|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(cleanedName);
        if (!looksLikeName) {
          bumpRetryGate();
          if (overRetry()) return hangMaxRetries();
          return safeSend(respond(tVoice(L, "perfect_name")));
        }
        s.name = cleanedName;
        if (req.session && typeof req.session === "object") req.session.name = cleanedName;
        s.machineState = VoiceState.PHONE_CAPTURE;
        s.phonePhase = "entry";
        s.pendingPhone10 = "";
        resetRetryGate();
        return safeSend(
          respondGatherDigits(ssmlSpeakPlain(tVoice(L, "voice_phone_enter_10")), { timeout: 12, numDigits: 10 }),
        );
      }

      /* ---- TIME_SELECTION: pick time ---- */
      if (s.machineState === VoiceState.TIME_SELECTION && s.timePhase === "pick_time" && inputRaw) {
        rememberVoice(inputRaw, "TIME_PICK");
        if (/\b(not|no|nah|different|another)\b/i.test(inputRaw)) {
          s.timeStr = "17:00";
          s.timeDisplay = "5 PM";
          s.timePhase = "pick_name";
          s.chooseTimeFails = 0;
          s.timeKeypad = false;
          resetRetryGate();
          if (req.session && typeof req.session === "object") req.session.time = "tomorrow at 5 PM";
          return safeSend(respond(tVoice(L, "not_time_alt_name")));
        }
        const picked = inferTimeSlotFromSpeech(inputRaw);
        if (picked) {
          s.timeStr = picked.timeStr;
          s.timeDisplay = picked.timeDisplay;
          s.timePhase = "pick_name";
          s.chooseTimeFails = 0;
          s.timeKeypad = false;
          resetRetryGate();
          if (req.session && typeof req.session === "object") {
            req.session.time = `tomorrow at ${picked.timeDisplay}`;
          }
          return safeSend(respond(tVoice(L, "locked_timing_name")));
        }
        s.chooseTimeFails = Number(s.chooseTimeFails || 0) + 1;
        if (s.chooseTimeFails >= 2) {
          s.timeKeypad = true;
          return safeSend(respondGatherDigits(tVoice(L, "time_keypad_prompt"), { timeout: 5, numDigits: 1 }));
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        return safeSend(respond(tVoice(L, "time_check_prompt")));
      }

      /* ---- SERVICE_SELECTION: NL + keypad escalation ---- */
      if (s.machineState === VoiceState.SERVICE_SELECTION && inputRaw) {
        let vi = auraVoiceIntentFromSpeech(inputRaw, L);
        if (vi && vi.matched) {
          rememberVoice(inputRaw, vi.intent);
          if (vi.intent === "BOOKING") {
            s.service = inferServiceFromSpeech(inputRaw);
            s.machineState = VoiceState.TIME_SELECTION;
            s.timePhase = "pick_time";
            s.timeKeypad = false;
            s.timeDisplay = "";
            s.timeStr = "";
            s.chooseTimeFails = 0;
            s.idleConfuse = 0;
            resetRetryGate();
            return safeSend(respond(tVoice(L, "time_tomorrow_question")));
          }
          if (vi.intent === "GENERAL") {
            s.idleConfuse = Number(s.idleConfuse || 0) + 1;
          } else {
            s.idleConfuse = 0;
          }
          if (Number(s.idleConfuse || 0) >= 2) {
            s.idleConfuse = 0;
            s.nlKeypadRetries = 0;
            s.keypadActive = true;
            return safeSend(respondKeypadNl());
          }
          let line = vi.reply;
          if (vi.intent === "GENERAL") {
            const hist = Array.isArray(s.voiceHistory) ? s.voiceHistory : [];
            const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
            if (prev?.intent === "GENERAL" && prev.line) {
              line = voiceGeneralClarify(L, prev.line);
            }
          }
          return safeSend(respond(line));
        }
        const rawLower = String(inputRaw || "").toLowerCase();
        if (/\b(book|haircut|fade|taper|beard|trim|appointment|cut)\b/.test(rawLower)) {
          s.service = inferServiceFromSpeech(inputRaw);
          s.machineState = VoiceState.TIME_SELECTION;
          s.timePhase = "pick_time";
          s.timeKeypad = false;
          resetRetryGate();
          return safeSend(respond(tVoice(L, "time_tomorrow_question")));
        }
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        return safeSend(respond(ssmlSpeakPlain(tVoice(L, "voice_service_prompt"))));
      }

      /* ---- Default: bounded reprompt (never restart greeting loop) ---- */
      if (s.machineState === VoiceState.SERVICE_SELECTION) {
        bumpRetryGate();
        if (overRetry()) return hangMaxRetries();
        return safeSend(respond(ssmlSpeakPlain(tVoice(L, "voice_service_prompt"))));
      }
      return hangMaxRetries();
    } catch (err) {
      console.error("AURA ERROR:", err?.stack || err);
      clearTimeout(timer);
      return safeSend(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${voiceSayXml(tVoice(L, "still_here_retry"))}
  <Gather input="speech" timeout="6" action="/api/aura/voice" method="POST" />
</Response>`);
    }
  };

  // Default: OpenAI + Gather voice loop. Set AURA_VOICE_WIZARD=1 for the legacy booking state machine.
  const useWizardVoice = String(process.env.AURA_VOICE_WIZARD || "").trim() === "1";
  console.log("[aura/voice] handler:", useWizardVoice ? "wizard (AURA_VOICE_WIZARD=1)" : "simple OpenAI (default)");
  if (useWizardVoice) {
    app.get("/api/aura/voice", voiceHandler);
    app.post("/api/aura/voice", voiceHandler);
    app.get("/api/aura/voice/incoming", voiceHandler);
    app.post("/api/aura/voice/incoming", voiceHandler);
  } else {
    const { voice: simpleVoice, process: simpleProcess } = createSimpleAuraVoiceHandlers({
      insertVoiceRow,
      dbQuery: opts.dbQuery,
    });
    // Twilio Voice webhook: POST …/api/aura/voice — GET kept for browser/Twilio probes only (one handler each).
    app.get("/api/aura/voice", simpleVoice);
    app.post("/api/aura/voice", simpleVoice);
    app.get("/api/aura/voice/incoming", simpleVoice);
    app.post("/api/aura/voice/incoming", simpleVoice);
    app.post("/api/aura/process", simpleProcess);
  }
}

/**
 * Twilio SMS → TwiML &lt;Message&gt; (always a body).
 * @param {import("express").Application} app
 * @param {{ insertVoiceRow?: (body: object) => Promise<object> }} [opts]
 */
export function attachAuraSmsWebhook(app, opts = {}) {
  startStyleTitlesCacheRefreshLoop();
  const insertVoiceRow =
    opts.insertVoiceRow ||
    (async (body) => {
      const { sendBookingEmail } = require("./bookingEmail.cjs");
      return insertAuraVoiceBookingRow(body, sendBookingEmail);
    });

  app.post("/api/aura/sms", async (req, res) => {
    if (!assertTwilioWebhookSignature(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const body = req.body || {};
    const from = String(body.From || "").trim();
    const msg = String(body.Body || "").trim();

    const safe = (text) => {
      sendSmsXml(res, text);
    };

    try {
      console.log("AURA INPUT:", msg || "(sms empty)");
      if (!from) {
        safe("Thanks for texting Imperial Foundation CDC Barbers.");
        return;
      }

      if (!auraSmsSessions.has(from)) {
        auraSmsSessions.set(from, { step: "idle", smsLang: "en" });
      }
      const sess = auraSmsSessions.get(from);
      const smsL = () => normalizeBarberLang(sess.smsLang || "en");

      if (!msg) {
        safe(auraKeywordFallbackReply(smsL()));
        return;
      }

      if (sess.step === "idle") {
        const kw = auraStructuredIntentFromKeywords(msg, smsL());
        if (!kw.matched) {
          console.log("AURA INTENT:", "LLM");
          safe(auraKeywordFallbackReply(smsL()));
          return;
        }
        console.log("AURA INTENT:", kw.intent);
        if (kw.intent === "NAVIGATE_BOOK") {
          sess.step = "sms_style";
          safe(smsBookOpenWithStyleAsk(smsL()));
          return;
        }
        if (kw.intent === "NAVIGATE_STYLES") {
          const titles = await auraFetchStyleTitles(25);
          const line = titles.length ? titles.join(", ") : "Open our app for the full style list.";
          safe(`Styles: ${line.length > 1400 ? `${line.slice(0, 1400)}…` : line}`);
          return;
        }
        if (kw.intent === "PRICING") {
          safe(chatKeywordReply(smsL(), "PRICING"));
          return;
        }
        safe(auraKeywordFallbackReply(smsL()));
        return;
      }

      if (sess.step === "sms_style") {
        sess.styleTitle = pickStyleTitleFromSpeechSync(msg);
        sess.step = "sms_barber";
        safe(smsWhoWouldYouLike(smsL()));
        return;
      }

      if (sess.step === "sms_barber") {
        const { id, name } = matchBarberFromSpeech(msg);
        sess.barberId = id;
        sess.barberName = name;
        try {
          const st = await loadBarberSettingsRow(id);
          sess.smsLang = st?.language || "en";
        } catch {
          sess.smsLang = "en";
        }
        sess.step = "sms_date";
        safe(smsWhatDay(smsL()));
        return;
      }

      if (sess.step === "sms_date") {
        const date = parseDateFromSpeech(msg);
        if (!date) {
          safe(`${FAILSAFE} What day? Try today or tomorrow.`);
          return;
        }
        sess.date = date;
        sess.step = "sms_time";
        safe(smsWhatTime(smsL()));
        return;
      }

      if (sess.step === "sms_time") {
        const time = parseTimeFromSpeech(msg);
        if (!time) {
          safe(`${FAILSAFE} What time works?`);
          return;
        }
        sess.time = time;
        sess.step = "sms_confirm";
        safe(smsConfirmPrompt(smsL(), sess.styleTitle, sess.barberName, sess.date, sess.time));
        return;
      }

      if (sess.step === "sms_confirm") {
        if (!isYes(msg)) {
          auraSmsSessions.delete(from);
          safe(smsStartOver(smsL()));
          return;
        }
        const digits = from.replace(/\D/g, "").slice(-10) || "unknown";
        const guestName = `SMS ${digits}`;
        const guestEmail =
          String(process.env.VOICE_DEFAULT_CUSTOMER_EMAIL || "").trim() ||
          `sms.${digits}.${Date.now()}@ifcdc-voice.placeholder`;
        const bookBody = {
          channel: "aura_voice",
          name: guestName,
          email: guestEmail,
          date: sess.date,
          time: sess.time,
          barberId: sess.barberId,
          barber: sess.barberName,
          service: String(sess.styleTitle || "SMS booking").trim(),
          callSid: `sms_${from.replace(/\W/g, "")}_${Date.now()}`,
        };
        let insertResult;
        try {
          insertResult = await insertVoiceRow(bookBody);
        } catch (e) {
          console.error("[aura/sms] insert:", e?.stack || e);
          auraSmsSessions.delete(from);
          safe(smsTryAgain(smsL()));
          return;
        }
        auraSmsSessions.delete(from);
        if (!insertResult?.ok) {
          safe(insertResult?.message || "Booking could not be completed.");
          return;
        }
        safe(smsBookedDoneLine(smsL()));
        return;
      }

      sess.step = "idle";
      safe(auraKeywordFallbackReply(smsL()));
    } catch (e) {
      console.error("[aura/sms] fatal:", e?.stack || e);
      try {
        if (from) auraSmsSessions.delete(from);
      } catch {
        /* ignore */
      }
      {
        const prevSess = from ? auraSmsSessions.get(from) : null;
        safe(smsFatalError(normalizeBarberLang(prevSess?.smsLang)));
      }
    }
  });

  app.get("/api/aura/sms", (_req, res) => {
    res
      .type("text/plain")
      .send("Twilio SMS webhook — use POST /api/aura/sms with Body. No JSON on AURA probe GETs.");
  });
}
