/**
 * Prompt-injection / unauthorized-ask guards for Phase 3A knowledge.
 * Customer text is always untrusted.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(your|the)\s+(rules|policies|instructions)/i,
  /reveal\s+(your|the)\s+(system|hidden|internal)\s+(prompt|instructions)/i,
  /show\s+(me\s+)?(the\s+)?(system\s+prompt|api\s+keys?|database\s+url|password)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /exfiltrat/i,
  /dump\s+(schema|tables?|env)/i,
  /override\s+(policy|safeguard|permission)/i,
];

const UNAUTHORIZED_PATTERNS = [
  // Policy FAQs about refunds are allowed; tooling / secrets / other customers are not.
  /\b(issue\s+a?\s*refund|process\s+(a\s+)?refund|refund\s+tooling|chargeback)\b/i,
  /\b(paypal\s+secret|admin\s+password|jwt\s+secret|api\s+keys?)\b/i,
  /\b(delete\s+all|drop\s+table|truncate)\b/i,
  /\b(other\s+customer|someone\s+else'?s\s+booking|customer\s+list)\b/i,
  /\b(ssn|social\s+security|credit\s+card\s+number|cvv|bank\s+account)\b/i,
];

function detectPromptInjection(text) {
  const s = String(text || "");
  for (const re of INJECTION_PATTERNS) {
    if (re.test(s)) return { blocked: true, reason: "prompt_injection" };
  }
  return { blocked: false };
}

function detectUnauthorizedAsk(text) {
  const s = String(text || "");
  for (const re of UNAUTHORIZED_PATTERNS) {
    if (re.test(s)) return { blocked: true, reason: "unauthorized_topic" };
  }
  return { blocked: false };
}

function sanitizeCustomerText(text, maxLen = 800) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .trim()
    .slice(0, maxLen);
}

module.exports = {
  INJECTION_PATTERNS,
  UNAUTHORIZED_PATTERNS,
  detectPromptInjection,
  detectUnauthorizedAsk,
  sanitizeCustomerText,
};
