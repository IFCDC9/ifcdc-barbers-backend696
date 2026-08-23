/**
 * AURA / booking language helpers.
 * Barber voice/SMS packs remain en | es. Customer chat can also select Hebrew (he)
 * from the app UI language for future Hebrew voice/text conversations.
 */

export function normalizeBarberLang(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "es" || s.startsWith("es")) return "es";
  return "en";
}

/**
 * Normalize a customer app language hint for AURA chat.
 * Recognizes en, es, and he (Hebrew). Legacy `iw` maps to he.
 * @returns {"en"|"es"|"he"|null}
 */
export function normalizeAuraClientLang(raw) {
  if (!raw) return null;
  const first = String(raw).toLowerCase().trim().split(/[,;]/)[0].trim();
  if (!first) return null;
  const primary = first.split("-")[0];
  if (primary === "he" || primary === "iw") return "he";
  if (primary === "es") return "es";
  if (primary === "en") return "en";
  return null;
}

/**
 * Pull the customer's app language from a chat request body / headers.
 * Looked-at sources (in order): body.language, body.locale, body.lang,
 * `Accept-Language` header. Returns "en", "es", "he", or null if not stated.
 *
 * @param {{ body?: any, get?: (h: string) => string | undefined, headers?: Record<string,string> }} req
 * @returns {"en"|"es"|"he"|null}
 */
export function detectClientLanguage(req) {
  const body = req && typeof req.body === "object" && req.body ? req.body : {};
  const headerVal =
    typeof req?.get === "function"
      ? req.get("Accept-Language")
      : req?.headers?.["accept-language"] || req?.headers?.["Accept-Language"];
  const candidates = [body.language, body.locale, body.lang, headerVal];
  for (const raw of candidates) {
    const hit = normalizeAuraClientLang(raw);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve the language AURA should respond in for a chat request.
 * Customer app preference (body/headers) wins. Falls back to the barber's
 * configured language, then to English. Returns "en" | "es" | "he".
 *
 * @param {object} req Express request
 * @param {string} [barberLang] Stored barber language (existing behavior)
 * @returns {"en"|"es"|"he"}
 */
export function resolveAuraLanguage(req, barberLang) {
  const explicit = detectClientLanguage(req);
  if (explicit) return explicit;
  return normalizeBarberLang(barberLang);
}

/** OpenAI system add-on so chat replies match the customer/barber language. */
export function openAiLanguageInstruction(lang) {
  const client = normalizeAuraClientLang(lang);
  if (client === "he") {
    return (
      " Always respond in Hebrew (עברית). Keep replies short and actionable." +
      " Prefer natural Israeli Hebrew. Keep names, phone numbers, dates, times," +
      " prices, and confirmation/reference numbers in their original form."
    );
  }
  return normalizeBarberLang(lang) === "es"
    ? " Always respond in Spanish (neutral Latin American). Keep replies short and actionable."
    : " Always respond in English. Keep replies short and actionable.";
}

/** Twilio <Say> voice + xml:lang for Polly. */
export function twilioSayAttributes(lang, preferredVoice) {
  if (normalizeBarberLang(lang) === "es") {
    return { voice: "Polly.Lucia", language: "es-ES" };
  }
  let v = String(preferredVoice || "").trim();
  if (!/^Polly\./i.test(v)) v = "Polly.Joanna";
  return { voice: v, language: "en-US" };
}

const VOICE = {
  en: {
    reconnect: "One moment, reconnecting you.",
    thank_hangup: "Thank you for choosing Imperial Foundation CDC. Have a great day.",
    anything_else: "Is there anything else I can help you with today?",
    enter_mobile_pound: "Please enter your mobile number followed by pound.",
    enter_mobile_retry: "I didn't catch that. Please enter your mobile number followed by pound.",
    how_else_help: "How else can I help you today?",
    tell_need_today: "Tell me what you need today and I'll help you.",
    keypad_intro: "Let me make this simple. Press 1 to book, 2 for hours, 3 for pricing.",
    time_tomorrow_question: "I got you. What time tomorrow works best — morning, afternoon, or a specific time?",
    time_feels_right: "What time feels right — morning, afternoon, or say it like two thirty PM.",
    time_keypad_prompt:
      "One moment while I handle that. Press 1 for morning, 2 for afternoon, 3 for early evening.",
    time_keypad_reprompt: "Pick 1 for morning, 2 for afternoon, 3 for early evening — or just tell me a time.",
    locked_timing_name: "You're locked in for timing — what name should I put on the chair?",
    thanks_calling_opener:
      "Thanks for calling Imperial Foundation CDC Barbers. Tell me what you need today and I'll help you.",
    listening_booking: "I'm listening — go ahead whenever you're ready.",
    listening_idle: "I'm listening — tell me what you need.",
    confirmation_sent: "Got you. I just sent that confirmation to your phone.",
    not_time_alt_name: "No problem — I can slide you later. What name should I put the appointment under?",
    time_check_prompt:
      "Let me check that for you — what time feels right? Morning, afternoon, or say it like two thirty PM.",
    perfect_name: "Perfect. What name should I put the appointment under?",
    post_confirm_anything: "Is there anything else I can help you with today?",
    book_hint_haircut: "No problem. If you want to book, just tell me haircut and I'll get you scheduled.",
    yes_no_confirm: "Just say yes to confirm, or no to cancel.",
    failsafe_voice: "I'm right here—just tell me what you need. You can say book, styles, or ask a question.",
    still_here: "I'm still here. Go ahead.",
    still_here_retry: "I'm still here. Go ahead and say that again.",
    customer_sms_thanks:
      "Thank you for choosing Imperial Foundation CDC. Your appointment is confirmed.",
    voice_service_prompt:
      "What service are we booking? Say haircut, fade, beard trim, or tell me what you need.",
    voice_phone_enter_10:
      "I need a 10-digit mobile number, area code first. Enter all 10 digits on your keypad now.",
    voice_phone_readback: "I have your number as {phone}. Is that correct?",
    voice_final_confirm_suffix: "Say yes to confirm your appointment.",
    voice_max_retries_goodbye:
      "I'm going to let you go for now. Call again anytime and we'll get you squared away.",
  },
  es: {
    reconnect: "Un momento, reconectando.",
    thank_hangup: "Gracias por elegir Imperial Foundation CDC. Que tengas un excelente día.",
    anything_else: "¿Hay algo más en lo que pueda ayudarte hoy?",
    enter_mobile_pound: "Ingrese su número de móvil seguido de la tecla numeral.",
    enter_mobile_retry: "No capté eso. Ingrese su móvil seguido de la tecla numeral.",
    how_else_help: "¿En qué más puedo ayudarle hoy?",
    tell_need_today: "Dígame qué necesita hoy y le ayudo.",
    keypad_intro: "Lo simplifico: presione 1 para reservar, 2 para horarios, 3 para precios.",
    time_tomorrow_question:
      "Listo. ¿Qué hora le viene bien mañana: mañana, tarde, o una hora concreta?",
    time_feels_right: "¿Qué hora le conviene: mañana, tarde, o dígala como dos y treinta de la tarde?",
    time_keypad_prompt: "Un momento. Presione 1 para mañana, 2 para tarde, 3 para al final de la tarde.",
    time_keypad_reprompt: "Presione 1 para mañana, 2 para tarde, 3 para al anochecer — o diga la hora.",
    locked_timing_name: "Horario anotado. ¿A qué nombre pongo la cita?",
    thanks_calling_opener:
      "Gracias por llamar a Imperial Foundation CDC Barbers. Dígame qué necesita hoy y le ayudo.",
    listening_booking: "Le escucho — adelante cuando quiera.",
    listening_idle: "Le escucho — dígame qué necesita.",
    confirmation_sent: "Listo. Acabo de enviarle esa confirmación a su teléfono.",
    not_time_alt_name: "Sin problema — puedo moverle más tarde. ¿A qué nombre pongo la cita?",
    time_check_prompt:
      "Déjeme ver. ¿Qué hora le va? Mañana, tarde, o dígala como dos y treinta de la tarde.",
    perfect_name: "Perfecto. ¿A qué nombre pongo la cita?",
    post_confirm_anything: "¿Hay algo más en lo que pueda ayudarte hoy?",
    book_hint_haircut: "Sin problema. Si quiere reservar, diga corte y lo agendo.",
    yes_no_confirm: "Diga sí para confirmar, o no para cancelar.",
    failsafe_voice: "Sigo aquí: diga reservar, estilos, o pregunte lo que necesite.",
    still_here: "Sigo aquí. Adelante.",
    still_here_retry: "Sigo aquí. Repítalo, por favor.",
    customer_sms_thanks:
      "Gracias por elegir Imperial Foundation CDC. Su cita está confirmada.",
    voice_service_prompt:
      "¿Qué servicio reservamos? Diga corte, fade, barba o lo que necesite.",
    voice_phone_enter_10:
      "Necesito un número móvil de 10 dígitos, con código de área primero. Ingrese los 10 dígitos en el teclado.",
    voice_phone_readback: "Tengo su número como {phone}. ¿Es correcto?",
    voice_final_confirm_suffix: "Diga sí para confirmar la cita.",
    voice_max_retries_goodbye:
      "Voy a colgar por ahora. Llame de nuevo cuando quiera y lo atendemos.",
  },
};

export function tVoice(lang, key) {
  const L = normalizeBarberLang(lang);
  const pack = VOICE[L] || VOICE.en;
  return pack[key] || VOICE.en[key] || key;
}

export function localizedUnclearFallback(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Le tengo. Puedo ayudarle a reservar, ver estilos o ver precios. Diga reservar corte, estilos o precios."
    : `I got you. I can help you book, view styles, or check pricing. Say book a haircut, ask for styles, or ask for pricing.`;
}

export function localizedKeywordFallback(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Estoy aquí para reservas, horarios, dirección, servicios y precios. Pregunte por horarios, reservar corte o estilos."
    : "I'm here for bookings, shop hours, directions, services, and pricing. Ask about hours, booking a haircut, or styles.";
}

/** Chat: keyword fast-path replies (server.js). */
export function auraChatNavigateBook(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Listo. Le preparo la reserva ahora."
    : "I got you. I'm setting up your booking now.";
}

export function auraChatNavigateStylesSuffix(lang) {
  return normalizeBarberLang(lang) === "es"
    ? " Elija uno en la app y continúe para reservar."
    : " Pick one in the app, then continue to book.";
}

/** Chat keyword router (auraStructuredIntentFromKeywords) — localized `reply` only. */
export function chatKeywordReply(lang, intent) {
  const es = normalizeBarberLang(lang) === "es";
  if (intent === "PRICING") {
    return es
      ? "Cada estilo tiene su precio. Abra Estilos en la app para comparar, o diga reservar corte cuando esté listo."
      : "Each style has its own price. Open Styles in the app to compare, or say book a haircut when you are ready.";
  }
  if (intent === "NAVIGATE_BOOK") {
    return es ? "Vamos a reservarle." : "Let's get you booked.";
  }
  if (intent === "NAVIGATE_STYLES") {
    return es ? "Aquí están nuestros estilos — abriendo la lista para usted." : "Here are our styles — opening the list for you.";
  }
  return "";
}

/** Spaced letters — Polly reads as initials; full SSML spelling lives in `auraVoiceSsml.js`. */
const shop = "I F C D C Barbers";

/** Phone AURA keyword intents (auraVoiceIntentFromSpeech). */
export function voiceIntentReply(lang, intent) {
  const es = normalizeBarberLang(lang) === "es";
  if (intent === "CANCEL") {
    return es
      ? "Entendido. Las cancelaciones las maneja el equipo para que no se pierda nada. Diga hablar con personal, o envíe un mensaje a la barbería después de esta llamada."
      : "I got you. Cancellations are handled by the team so nothing slips through the cracks. Say speak to staff, or text the shop after this call.";
  }
  if (intent === "RESCHEDULE") {
    return es
      ? "Déjeme ver. Los cambios de cita pasan por recepción — diga hablar con personal y lo resolvemos rápido."
      : "Let me check that for you. Reschedules go through the front desk — say speak to staff and we'll sort it fast.";
  }
  if (intent === "LATE_ARRIVAL") {
    return es
      ? "No se preocupe. Avísenos cuando pueda y cuidamos su lugar el mayor tiempo posible. Diga hablar con personal si va muy justo."
      : "You're good — it happens. Give us a heads-up when you can, and we'll protect your chair as long as we can. Say speak to staff if you're cutting it close.";
  }
  if (intent === "SPEAK_TO_STAFF") {
    return es
      ? "Un momento. Para una respuesta a nivel dueño, pida recepción en horario de atención — diga horarios si necesita cuándo abrimos."
      : "One moment while I handle that. For the owner-level answer, ask for the front desk during business hours — say hours if you need our open times.";
  }
  if (intent === "DIRECTIONS") {
    return es
      ? `Listo. Abra ${shop} en el teléfono para el pin del mapa, o diga horarios y le indico el mejor momento para llegar.`
      : `I got you. Open ${shop} on your phone for the map pin, or say hours and I'll line up the best time to pull up.`;
  }
  if (intent === "HOURS") {
    return es
      ? "Horarios profesionales, con energía de siete días a la semana — diga dirección si necesita la dirección, o dígame qué necesita y lo canalizo."
      : "We're professional hours, seven days a week energy — say directions if you need the address, or tell me what you need and I'll route it.";
  }
  if (intent === "PRICING") {
    return es
      ? "Déjeme ver. El precio depende del corte y del barbero — abra Estilos en la app para números exactos, o diga reservar cuando quiera cerrar."
      : "Let me check that for you. Pricing tracks the cut and the barber — open Styles in the app for exact numbers, or say book when you're ready to lock in.";
  }
  if (intent === "BARBER_AVAILABILITY") {
    return es
      ? "Listo. Los turnos vuelan rápido — dígame el día que quiere y lo meto al flujo de reserva."
      : "I got you. Chairs turn fast — tell me the day you want, and I'll get you into the booking flow clean.";
  }
  if (intent === "GENERAL") {
    return es
      ? "Le tengo. Puedo ayudarle con reservas, horarios, dirección, precios o recepción — dígame qué necesita hoy."
      : "I got you. I'm here for booking, hours, directions, pricing, or the front desk — tell me what you need today.";
  }
  return "";
}

/** Twilio SMS: post-booking one-liner */
export function smsBookedDoneLine(lang) {
  return normalizeBarberLang(lang) === "es" ? "Listo, quedó reservado. Nos vemos." : "You're booked. See you then.";
}

/** Twilio SMS: voice-style confirmation text to customer */
export function voiceSmsAppointmentLine(lang, when) {
  const w = String(when || "").trim();
  return normalizeBarberLang(lang) === "es"
    ? `Su cita quedó confirmada para ${w}. - I F C D C Barbers`
    : `Your appointment is confirmed for ${w}. - I F C D C Barbers`;
}

/** Voice: confirm step after name + time */
export function voiceConfirmLockIn(lang, name, whenPhrase) {
  const n = String(name || "").trim();
  const wh = String(whenPhrase || "").trim() || "tomorrow";
  return normalizeBarberLang(lang) === "es"
    ? `De acuerdo, ${n}, puedo dejarle para ${wh}. Diga sí para confirmar.`
    : `Alright ${n}, I can lock you in for ${wh}. Say yes to confirm.`;
}

/** Voice: repeat intent when two GENERAL turns */
export function voiceGeneralClarify(lang, prevSnippet) {
  const prev = String(prevSnippet || "").slice(0, 72);
  return normalizeBarberLang(lang) === "es"
    ? `Le escuché en «${prev}». Dígame si es reserva, horarios, dirección, precios o recepción.`
    : `I heard you on "${prev}". Tell me if that's booking, hours, directions, pricing, or the front desk.`;
}

/** Voice closeout / admin log line */
export function voiceTimeLineTomorrow(lang, timeDisplay) {
  const t = String(timeDisplay || "").trim();
  if (normalizeBarberLang(lang) === "es") {
    return t ? `Mañana a las ${t}` : "Mañana";
  }
  return t ? `Tomorrow at ${t}` : "Tomorrow";
}

/** SMS booking wizard (after barber chosen → `smsLang`) */
export function smsBookOpenWithStyleAsk(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Vamos a reservarle. ¿Qué estilo quiere? Por ejemplo fade, taper o corte."
    : "Let's get you booked. What style would you like? For example fade, taper, or haircut.";
}

export function smsWhoWouldYouLike(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "¿Con quién quiere? Diga un barbero o responda CUALQUIERA para el primero disponible."
    : "Who would you like? Name a barber, or reply ANY for first available.";
}

export function smsWhatDay(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "¿Qué día le viene bien? Diga hoy, mañana o una fecha como 2026-04-20."
    : "What day works? Say today, tomorrow, or a date like 2026-04-20.";
}

export function smsWhatTime(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "¿Qué hora? Mañana, tarde, o una hora como 3:30 PM."
    : "What time? Morning, afternoon, or a time like 3:30 PM.";
}

export function smsConfirmPrompt(lang, style, barber, date, time) {
  if (normalizeBarberLang(lang) === "es") {
    return `Confirme: ${style} con ${barber} el ${date} a las ${time}. Responda SI para reservar.`;
  }
  return `Confirm: ${style} with ${barber} on ${date} at ${time}. Reply YES to book.`;
}

export function smsStartOver(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "De acuerdo — escríbanos cuando quiera para empezar de nuevo."
    : "Okay — text us anytime to start over.";
}

export function smsTryAgain(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Lo siento, hubo un problema. Inténtelo de nuevo o use la app."
    : "Sorry, something went wrong. Please try again or use the app.";
}

export function smsFatalError(lang) {
  return normalizeBarberLang(lang) === "es"
    ? "Lo siento, algo salió mal. Inténtelo de nuevo."
    : "Sorry, something went wrong. Please try again.";
}
