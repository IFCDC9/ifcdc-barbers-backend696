/**
 * Twilio Media Stream adapter for the Aura × Pipecat path.
 * Live Twilio console config is unchanged. Tests use the mock stream.
 */

function createMockTwilioStream({ callSid = "CA-mock", streamSid = "MZ-mock" } = {}) {
  const events = [];
  let cleared = 0;
  return {
    provider: "mock-twilio-media-stream",
    callSid,
    streamSid,
    connected: true,
    events,
    sendConnected() {
      events.push({ event: "connected", protocol: "Call", version: "1.0.0" });
    },
    sendStart() {
      events.push({ event: "start", start: { callSid, streamSid } });
    },
    sendMedia(payloadB64) {
      events.push({ event: "media", media: { payload: String(payloadB64 || "") } });
    },
    sendMark(name) {
      events.push({ event: "mark", mark: { name: String(name || "pipecat") } });
    },
    sendClear() {
      cleared += 1;
      events.push({ event: "clear" });
    },
    interrupt() {
      this.sendClear();
      events.push({ event: "interrupt" });
      return { cancelled: true, cleared };
    },
    sendStop() {
      events.push({ event: "stop" });
      this.connected = false;
    },
    get cleared() {
      return cleared;
    },
  };
}

function twilioHqStatus() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const configured = Boolean(sid && token);
  return {
    status: configured ? "CONFIGURED" : "UNCONFIGURED",
    mediaStreams: "optional_pipecat_path",
    gather: "production_default",
    signatureValidation: String(process.env.TWILIO_VALIDATE_SIGNATURE || "") === "true",
    note: "Twilio phone numbers / webhook URLs are not modified by Pipecat. Mock stream is used in tests.",
  };
}

function pollyHqStatus() {
  return {
    status: "PRODUCTION_PRIMARY",
    path: "Twilio <Say> Polly",
    voices: { en: "Polly.Joanna", es: "Polly.Lucia", he: "Polly.Joanna (no HE voice on this stack)" },
    productionActivation: "ON",
    note: "Default live-call TTS. Voicebox/Pipecat stay off until Tessa enables VOICEBOX_PRIMARY.",
  };
}

module.exports = {
  createMockTwilioStream,
  twilioHqStatus,
  pollyHqStatus,
};
