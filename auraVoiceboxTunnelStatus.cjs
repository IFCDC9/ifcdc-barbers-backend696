/**
 * Local runtime heartbeat for Aura voice Mac services.
 * Never reports online if Voicebox is down or the heartbeat is stale (Mac sleep/off).
 */

const fs = require("fs");
const path = require("path");

const RUNTIME_PATH = path.join(__dirname, "data", "aura-voice-runtime.json");
const STALE_MS = 25_000;

function readVoiceRuntime() {
  try {
    const raw = fs.readFileSync(RUNTIME_PATH, "utf8");
    const json = JSON.parse(raw);
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

function heartbeatAgeMs(row = readVoiceRuntime()) {
  if (!row?.heartbeatAt) return null;
  const at = Date.parse(row.heartbeatAt);
  if (!Number.isFinite(at)) return null;
  return Date.now() - at;
}

function isRuntimeStale(row = readVoiceRuntime()) {
  const age = heartbeatAgeMs(row);
  return age == null || age > STALE_MS;
}

function isMacVoiceOnline(row = readVoiceRuntime()) {
  if (!row) return false;
  if (isRuntimeStale(row)) return false;
  if (row.online !== true) return false;
  if (row.voicebox?.ok !== true) return false;
  if (row.macAsleep === true) return false;
  return true;
}

function writeVoiceRuntime(row) {
  const dir = path.dirname(RUNTIME_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const online = Boolean(row?.voicebox?.ok) && row?.proxy?.ok !== false && row?.macAsleep !== true;
  const body = {
    ...row,
    online,
    heartbeatAt: new Date().toISOString(),
  };
  fs.writeFileSync(RUNTIME_PATH, JSON.stringify(body, null, 2));
  return body;
}

module.exports = {
  RUNTIME_PATH,
  STALE_MS,
  readVoiceRuntime,
  heartbeatAgeMs,
  isRuntimeStale,
  isMacVoiceOnline,
  writeVoiceRuntime,
};
