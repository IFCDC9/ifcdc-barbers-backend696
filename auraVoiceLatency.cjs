/**
 * AURA voice turn timing + filler acknowledgments for perceived latency.
 * Does not change Twilio credentials, booking commit rules, payments, or A2P.
 */

const ACK_WHILE_WAITING = [
  "Got it...",
  "One moment while I check availability...",
  "Checking the schedule now...",
  "One moment...",
];

const ackIdxByCall = new Map();
const ACK_CAP = 2000;

/** Rolling samples for report (process-local). */
const samples = {
  speechToResponseMs: [],
  bookingLookupMs: [],
  responseGenerationMs: [],
  totalTurnMs: [],
};
const SAMPLE_CAP = 200;

function pushSample(arr, ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  arr.push(n);
  while (arr.length > SAMPLE_CAP) arr.shift();
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function recordVoiceTiming(partial = {}) {
  if (partial.speechToResponseMs != null) pushSample(samples.speechToResponseMs, partial.speechToResponseMs);
  if (partial.bookingLookupMs != null) pushSample(samples.bookingLookupMs, partial.bookingLookupMs);
  if (partial.responseGenerationMs != null) {
    pushSample(samples.responseGenerationMs, partial.responseGenerationMs);
  }
  if (partial.totalTurnMs != null) pushSample(samples.totalTurnMs, partial.totalTurnMs);
  console.log("[aura/voice-metrics]", {
    speechToResponseMs: partial.speechToResponseMs ?? null,
    bookingLookupMs: partial.bookingLookupMs ?? null,
    responseGenerationMs: partial.responseGenerationMs ?? null,
    totalTurnMs: partial.totalTurnMs ?? null,
    averages: getVoiceLatencyAverages(),
  });
}

function getVoiceLatencyAverages() {
  return {
    avgSpeechToResponseMs: avg(samples.speechToResponseMs),
    avgBookingLookupMs: avg(samples.bookingLookupMs),
    avgResponseGenerationMs: avg(samples.responseGenerationMs),
    avgTotalTurnMs: avg(samples.totalTurnMs),
    sampleCounts: {
      speechToResponse: samples.speechToResponseMs.length,
      bookingLookup: samples.bookingLookupMs.length,
      responseGeneration: samples.responseGenerationMs.length,
      totalTurn: samples.totalTurnMs.length,
    },
  };
}

/** Rotating filler when backend work may exceed ~1s (skip for welcome greetings). */
function waitingAckPhrase(callSid) {
  const key = String(callSid || "").trim() || "__";
  let i = ackIdxByCall.get(key) || 0;
  const phrase = ACK_WHILE_WAITING[i % ACK_WHILE_WAITING.length];
  ackIdxByCall.set(key, i + 1);
  while (ackIdxByCall.size > ACK_CAP) {
    const first = ackIdxByCall.keys().next().value;
    if (first === undefined) break;
    ackIdxByCall.delete(first);
  }
  return phrase;
}

module.exports = {
  ACK_WHILE_WAITING,
  waitingAckPhrase,
  recordVoiceTiming,
  getVoiceLatencyAverages,
};
