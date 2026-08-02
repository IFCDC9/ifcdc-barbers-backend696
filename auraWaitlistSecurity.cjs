/**
 * Phase 3B2 waitlist input guards — customer text is untrusted.
 */
const { detectPromptInjection, sanitizeCustomerText } = require("./auraKnowledgeSecurity.cjs");

const MAX_OFFERS_PER_CUSTOMER_PER_DAY = 3;
const DEFAULT_OFFER_TTL_MINUTES = 15;

function detectUnsafeWaitlistText(text) {
  const s = String(text || "");
  const injection = detectPromptInjection(s);
  if (injection.blocked) return { blocked: true, reason: "prompt_injection" };
  if (/\b(other\s+customer|someone\s+else|ssn|credit\s+card|password)\b/i.test(s)) {
    return { blocked: true, reason: "prohibited_content" };
  }
  return { blocked: false };
}

function normalizeTime(t) {
  const s = String(t || "").trim();
  if (!s) return null;
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  return s;
}

function normalizeDate(d) {
  if (!d) return null;
  const s = String(d).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Normalize join/update payload. Does not invent barber/service qualifications —
 * callers must supply known IDs/names from live catalog when possible.
 */
function normalizeWaitlistCriteria(raw = {}) {
  const barberId = String(raw.barberId || raw.barber_id || "").trim() || null;
  const barberName = sanitizeCustomerText(raw.barberName || raw.barber_name || "", 120) || null;
  const anyQualifiedBarber = raw.anyQualifiedBarber === true || raw.any_qualified_barber === true;
  const earliestAvailable = raw.earliestAvailable === true || raw.earliest_available === true;
  const serviceId = String(raw.serviceId || raw.service_id || "").trim() || null;
  const serviceName = sanitizeCustomerText(raw.serviceName || raw.service_name || raw.service || "", 120) || null;

  const preferredDate = normalizeDate(raw.preferredDate || raw.preferred_date || raw.date);
  const dateFrom = normalizeDate(raw.dateFrom || raw.date_from || raw.dateRangeStart);
  const dateTo = normalizeDate(raw.dateTo || raw.date_to || raw.dateRangeEnd);
  const earliestAcceptableDate = normalizeDate(
    raw.earliestAcceptableDate || raw.earliest_acceptable_date,
  );
  const timeStart = normalizeTime(raw.timeRangeStart || raw.time_range_start || raw.timeStart);
  const timeEnd = normalizeTime(raw.timeRangeEnd || raw.time_range_end || raw.timeEnd);
  const expiresAt = raw.expiresAt || raw.expires_at || null;

  const textBlob = [barberName, serviceName, raw.notes, raw.criteriaSummary].filter(Boolean).join(" ");
  const unsafe = detectUnsafeWaitlistText(textBlob);
  if (unsafe.blocked) return { ok: false, error: unsafe.reason };

  if (!anyQualifiedBarber && !earliestAvailable && !barberId && !barberName) {
    return { ok: false, error: "barber_or_flexibility_required" };
  }
  if (!serviceName && !serviceId && !earliestAvailable) {
    // Allow earliest-available without service, but prefer service when possible.
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return { ok: false, error: "invalid_date_range" };
  }
  if ((timeStart && !timeEnd) || (!timeStart && timeEnd)) {
    return { ok: false, error: "time_range_incomplete" };
  }

  const summaryParts = [];
  if (anyQualifiedBarber) summaryParts.push("any qualified barber");
  else if (barberName || barberId) summaryParts.push(`barber ${barberName || barberId}`);
  if (serviceName) summaryParts.push(`service ${serviceName}`);
  if (preferredDate) summaryParts.push(`date ${preferredDate}`);
  if (dateFrom || dateTo) summaryParts.push(`range ${dateFrom || "…"}–${dateTo || "…"}`);
  if (earliestAcceptableDate) summaryParts.push(`earliest ${earliestAcceptableDate}`);
  if (timeStart && timeEnd) summaryParts.push(`time ${timeStart}–${timeEnd}`);
  if (earliestAvailable) summaryParts.push("earliest available appointment");

  return {
    ok: true,
    value: {
      barberId,
      barberName,
      anyQualifiedBarber,
      serviceId,
      serviceName,
      preferredDate,
      dateFrom,
      dateTo,
      earliestAcceptableDate,
      timeRangeStart: timeStart,
      timeRangeEnd: timeEnd,
      earliestAvailable,
      expiresAt,
      matchFlexibility: {
        anyQualifiedBarber,
        earliestAvailable,
      },
      criteriaSummary: summaryParts.join("; ") || "waitlist request",
    },
  };
}

function buildWaitlistConsentPrompt(criteria) {
  return `Please confirm you want to join the waitlist for: ${criteria.criteriaSummary}. Joining does not book or charge you. Reply yes to save.`;
}

/**
 * Transparent ranking only — no hidden value/payment/protected-characteristic scoring.
 * Higher score = better match; FIFO on ties via created_at.
 */
function scoreWaitlistMatch(request, slot) {
  let score = 0;
  const reasons = [];
  if (request.any_qualified_barber || request.anyQualifiedBarber) {
    score += 5;
    reasons.push("any_qualified_barber");
  } else if (
    (request.barber_id && slot.barberId && String(request.barber_id) === String(slot.barberId)) ||
    (request.barber_name &&
      slot.barberName &&
      String(request.barber_name).toLowerCase() === String(slot.barberName).toLowerCase())
  ) {
    score += 40;
    reasons.push("matching_barber");
  } else if (!request.earliest_available && !request.earliestAvailable) {
    return { score: 0, reasons: ["barber_mismatch"], eligible: false };
  }

  if (request.service_name || request.serviceName) {
    const want = String(request.service_name || request.serviceName).toLowerCase();
    const got = String(slot.serviceName || "").toLowerCase();
    if (got && want === got) {
      score += 30;
      reasons.push("matching_service");
    } else if (got && want) {
      return { score: 0, reasons: ["service_mismatch"], eligible: false };
    }
  }

  const slotDate = String(slot.slotDate || "").slice(0, 10);
  const preferred = request.preferred_date || request.preferredDate;
  const from = request.date_from || request.dateFrom;
  const to = request.date_to || request.dateTo;
  const earliest = request.earliest_acceptable_date || request.earliestAcceptableDate;
  if (preferred) {
    if (slotDate === String(preferred).slice(0, 10)) {
      score += 20;
      reasons.push("matching_date");
    } else {
      return { score: 0, reasons: ["date_mismatch"], eligible: false };
    }
  } else if (from || to) {
    if (from && slotDate < String(from).slice(0, 10)) {
      return { score: 0, reasons: ["before_date_range"], eligible: false };
    }
    if (to && slotDate > String(to).slice(0, 10)) {
      return { score: 0, reasons: ["after_date_range"], eligible: false };
    }
    score += 15;
    reasons.push("within_date_range");
  } else if (earliest) {
    if (slotDate < String(earliest).slice(0, 10)) {
      return { score: 0, reasons: ["before_earliest_date"], eligible: false };
    }
    score += 10;
    reasons.push("on_or_after_earliest");
  } else if (request.earliest_available || request.earliestAvailable) {
    score += 8;
    reasons.push("earliest_available");
  }

  const tStart = request.time_range_start || request.timeRangeStart;
  const tEnd = request.time_range_end || request.timeRangeEnd;
  const slotTime = String(slot.slotTime || "").slice(0, 5);
  if (tStart && tEnd && slotTime) {
    if (slotTime >= tStart && slotTime <= tEnd) {
      score += 15;
      reasons.push("matching_time_range");
    } else {
      return { score: 0, reasons: ["time_mismatch"], eligible: false };
    }
  }

  return { score, reasons, eligible: score > 0 };
}

module.exports = {
  MAX_OFFERS_PER_CUSTOMER_PER_DAY,
  DEFAULT_OFFER_TTL_MINUTES,
  detectUnsafeWaitlistText,
  normalizeWaitlistCriteria,
  buildWaitlistConsentPrompt,
  scoreWaitlistMatch,
  sanitizeCustomerText,
};
