/**
 * Voice memory + pronunciation dictionary for AURA speech.
 * Persistent extras live in auraVoiceMemory.cjs (Founder-correctable).
 * Does not change booking copy sources — only the text sent to TTS.
 */

const STATIC_TERMS = [
  { pattern: /\bI\.?\s*F\.?\s*C\.?\s*D\.?\s*C\b/gi, speak: "I F C D C", id: "ifcdc" },
  { pattern: /\bIFCDC\b/g, speak: "I F C D C", id: "ifcdc_compact" },
  { pattern: /\bAURA ALLAH\b/gi, speak: "Aura", id: "aura_allah" },
  { pattern: /\bAURA\b/g, speak: "Aura", id: "aura" },
];

const SERVICE_TERMS = [
  { pattern: /\bfade\b/gi, speak: "fade", id: "service_fade" },
  { pattern: /\bhaircut\b/gi, speak: "haircut", id: "service_haircut" },
  { pattern: /\bbeard trim\b/gi, speak: "beard trim", id: "service_beard" },
  { pattern: /\blineup\b/gi, speak: "lineup", id: "service_lineup" },
  { pattern: /\btaper\b/gi, speak: "taper", id: "service_taper" },
  { pattern: /\bbuzz cut\b/gi, speak: "buzz cut", id: "service_buzz" },
];

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

function hourWord(h) {
  const n = ((Number(h) % 12) + 12) % 12;
  if (n === 0) return "twelve";
  return ONES[n];
}

function minuteWords(m) {
  const n = Number(m);
  if (n === 0) return "o'clock";
  if (n < 10) return `oh ${ONES[n]}`;
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

function expandEnglishTime(text) {
  return String(text || "").replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi,
    (_m, hh, mm, ap) => {
      const meridiem = /p/i.test(ap) ? "P M" : "A M";
      const hour = hourWord(hh);
      if (!mm || mm === "00") return `${hour} ${meridiem}`;
      return `${hour} ${minuteWords(mm)} ${meridiem}`;
    },
  );
}

function expandDigitRuns(text) {
  return String(text || "").replace(/\b(\d{4,})\b/g, (_m, digits) => digits.split("").join(" "));
}

function applyDict(text, extras = []) {
  let out = String(text || "");
  const all = [...STATIC_TERMS, ...SERVICE_TERMS, ...extras];
  for (const row of all) {
    if (!row?.pattern || !row.speak) continue;
    out = out.replace(row.pattern, row.speak);
  }
  return out;
}

/**
 * Prepare spoken text for TTS. Language change is the caller's; this only
 * rewrites tokens. Extra Founder entries: [{pattern, speak}] or [{from, to}].
 */
function prepareSpokenText(text, { language = "en", extras = [] } = {}) {
  const extraRows = extras.map((e) => {
    if (e?.pattern && e.speak) return e;
    const from = String(e?.from || e?.term || "").trim();
    const to = String(e?.to || e?.speak || "").trim();
    if (!from || !to) return null;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { pattern: new RegExp(`\\b${escaped}\\b`, "gi"), speak: to, id: e.id || from };
  }).filter(Boolean);

  let out = applyDict(text, extraRows);
  const lang = String(language || "en").slice(0, 2).toLowerCase();
  if (lang === "en") out = expandEnglishTime(out);
  out = expandDigitRuns(out);
  return out.replace(/\s+/g, " ").trim();
}

function defaultDictionary() {
  return [
    { id: "ifcdc", term: "IFCDC", speak: "I F C D C" },
    { id: "aura_allah", term: "AURA Allah", speak: "Aura" },
    { id: "aura", term: "AURA", speak: "Aura" },
    { id: "imperial", term: "Imperial Foundation CDC", speak: "Imperial Foundation C D C" },
  ];
}

module.exports = {
  prepareSpokenText,
  defaultDictionary,
  STATIC_TERMS,
};
