/**
 * Caller intent detection for AURA Voice Intelligence Phase 1.
 * Keyword / phrase heuristics — no invented shop facts.
 */

const INTENT_PATTERNS = [
  { intent: "cancel_appointment", re: /\b(cancel|cancellation|call off)\b/i },
  { intent: "reschedule_appointment", re: /\b(reschedule|move (my |the )?appointment|change (my |the )?(time|date|appointment))\b/i },
  { intent: "book_appointment", re: /\b(book|booking|schedule|reserve|make a (cut|appt)|need a haircut|set up an appointment)\b/i },
  { intent: "check_appointment_status", re: /\b(appointment status|my (booking|appointment)|when is my|do i have an appointment)\b/i },
  { intent: "find_barber", re: /\b(find (a |an )?barber|who (is |are )?available|first available|any barber)\b/i },
  { intent: "barber_availability", re: /\b(available|availability|openings?|free slots?|when (can|is).*(free|open))\b/i },
  { intent: "ask_prices", re: /\b(price|pricing|cost|how much|fee|rates?)\b/i },
  { intent: "ask_duration", re: /\b(how long|duration|takes? how|minutes|hour)\b/i },
  { intent: "ask_services", re: /\b(services?|what do you offer|menu|styles?|fade|beard|lineup|taper)\b/i },
  { intent: "ask_hours", re: /\b(hours?|open|close|closing|opening|what time.*(open|close))\b/i },
  { intent: "ask_location", re: /\b(location|address|directions?|where (are|is) you|how (do i|to) get)\b/i },
  { intent: "payment_status", re: /\b(payment status|did (my )?payment|paid|pay(ment)? (go|went)|charge)\b/i },
  { intent: "payment_link", re: /\b(payment link|pay link|send (me )?(a )?link|pay online|paypal)\b/i },
  { intent: "rewards", re: /\b(rewards?|loyalty|points|punch card)\b/i },
  { intent: "reviews", re: /\b(reviews?|ratings?|stars?|feedback)\b/i },
  { intent: "booking_problem", re: /\b(booking (problem|issue|error)|can'?t book|won'?t book)\b/i },
  { intent: "payment_problem", re: /\b(payment (problem|issue|failed|error)|can'?t pay|overcharged)\b/i },
  { intent: "customer_support", re: /\b(support|help me|customer service|assistance)\b/i },
  { intent: "request_human", re: /\b(human|real person|agent|manager|administrator|speak to (someone|a person)|operator)\b/i },
  { intent: "general_question", re: /\b(what is ifcdc|who are you|aura|about (the )?(shop|app|ifcdc))\b/i },
  { intent: "owner_ops", re: /\b(today'?s (bookings?|summary)|new customers?|system health|operations|founder (brief|mode)|executive (brief|summary))\b/i },
];

const CARD_PAN_RE = /(?:\d[ -]*){13,19}/;
const CVV_RE = /\b(cvv|cvc|security code)\b/i;
const BANK_PASS_RE = /\b(password|pin code|routing number|account number)\b/i;

function detectPaymentCardRisk(text) {
  const t = String(text || "");
  if (CARD_PAN_RE.test(t.replace(/\s/g, "")) || CVV_RE.test(t) || BANK_PASS_RE.test(t)) {
    return {
      blocked: true,
      reply:
        "For your security I never collect card numbers, CVV codes, or banking passwords. I can explain payment status or send a secure payment link after we confirm your booking.",
    };
  }
  return { blocked: false };
}

/**
 * @returns {{ primary: string, all: string[], multi: boolean }}
 */
function detectCallerIntents(raw) {
  const text = String(raw || "").trim();
  if (!text || text.startsWith("__IFCDC_")) {
    return { primary: "greeting", all: ["greeting"], multi: false };
  }
  const hits = [];
  for (const row of INTENT_PATTERNS) {
    if (row.re.test(text)) hits.push(row.intent);
  }
  if (!hits.length) {
    if (/\b(yes|yeah|yep|correct|no|nope)\b/i.test(text)) {
      return { primary: "confirm_reply", all: ["confirm_reply"], multi: false };
    }
    return { primary: "unclear", all: ["unclear"], multi: false };
  }
  const unique = [...new Set(hits)];
  return {
    primary: unique[0],
    all: unique,
    multi: unique.length > 1,
  };
}

function intentSpokenLabel(intent) {
  const map = {
    book_appointment: "booking an appointment",
    reschedule_appointment: "rescheduling",
    cancel_appointment: "cancellation",
    check_appointment_status: "checking an appointment",
    find_barber: "finding a barber",
    barber_availability: "barber availability",
    ask_services: "services",
    ask_prices: "pricing",
    ask_duration: "appointment duration",
    ask_hours: "shop hours",
    ask_location: "location",
    payment_status: "payment status",
    payment_link: "a secure payment link",
    rewards: "rewards",
    reviews: "reviews",
    booking_problem: "a booking problem",
    payment_problem: "a payment problem",
    customer_support: "support",
    request_human: "reaching a team member",
    general_question: "general questions",
    owner_ops: "operations",
    greeting: "getting started",
    unclear: "your request",
    confirm_reply: "confirmation",
  };
  return map[intent] || "your request";
}

module.exports = {
  INTENT_PATTERNS,
  detectCallerIntents,
  detectPaymentCardRisk,
  intentSpokenLabel,
};
