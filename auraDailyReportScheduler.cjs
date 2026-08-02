/**
 * AURA daily Super Admin report scheduler.
 * Arms only when AURA_DAILY_REPORT_ENABLED is on.
 * Sends at AURA_DAILY_REPORT_HOUR:MINUTE in SHOP_TIMEZONE (default America/New_York).
 * Never catch-up-sends on boot/deploy — only when local clock matches the configured minute.
 */
const { auraPhase2Flags } = require("./auraPhase2Flags.cjs");
const { shopTimezone } = require("./auraDailyReport.cjs");

function parseHourMinute() {
  const hourRaw = process.env.AURA_DAILY_REPORT_HOUR;
  const minuteRaw = process.env.AURA_DAILY_REPORT_MINUTE;
  const hourConfigured = hourRaw != null && String(hourRaw).trim() !== "";
  const minuteConfigured = minuteRaw != null && String(minuteRaw).trim() !== "";
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw == null || String(minuteRaw).trim() === "" ? 0 : minuteRaw);
  return {
    hourConfigured,
    minuteConfigured: minuteConfigured || hourConfigured,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : null,
  };
}

function partsInTimezone(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

function getDailyReportScheduleConfig() {
  const flags = auraPhase2Flags();
  const tz = shopTimezone();
  const hm = parseHourMinute();
  const recipient = String(
    process.env.AURA_DAILY_REPORT_TO || process.env.BOOKING_ADMIN_EMAIL || "",
  )
    .trim()
    .toLowerCase();

  return {
    sendEnabled: Boolean(flags.dailyReportSend),
    previewEnabled: Boolean(flags.dailyReportPreview),
    timezone: tz,
    hour: hm.hour,
    minute: hm.minute,
    hourConfigured: hm.hourConfigured,
    scheduleConfigured: hm.hour != null && hm.minute != null && hm.hourConfigured,
    recipient: recipient || null,
  };
}

/**
 * Next run at configured local hour:minute in shop TZ (never "catch up" to a past slot today
 * after the minute has passed — advances to tomorrow).
 */
function getNextDailyReportRunAt(now = new Date()) {
  const cfg = getDailyReportScheduleConfig();
  if (!cfg.scheduleConfigured) {
    return { ok: false, error: "schedule_not_configured", ...cfg };
  }

  const local = partsInTimezone(now, cfg.timezone);
  let targetYmd = local.ymd;
  const pastOrEqualToday =
    local.hour > cfg.hour || (local.hour === cfg.hour && local.minute >= cfg.minute);
  if (pastOrEqualToday) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    // Walk forward until local calendar day advances (handles DST edges).
    let probe = tomorrow;
    for (let i = 0; i < 48; i++) {
      const p = partsInTimezone(probe, cfg.timezone);
      if (p.ymd !== local.ymd) {
        targetYmd = p.ymd;
        break;
      }
      probe = new Date(probe.getTime() + 30 * 60 * 1000);
    }
  }

  // Find a UTC instant whose local parts match targetYmd + hour:minute.
  const [y, m, d] = targetYmd.split("-").map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, cfg.hour + 4, cfg.minute, 0)); // NY≈UTC-4 summer
  for (let i = 0; i < 80; i++) {
    const p = partsInTimezone(guess, cfg.timezone);
    if (p.ymd === targetYmd && p.hour === cfg.hour && p.minute === cfg.minute) {
      return {
        ok: true,
        ...cfg,
        nextRunAt: guess.toISOString(),
        nextRunLocal: `${targetYmd} ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")} ${cfg.timezone}`,
        schedulerArmed: Boolean(cfg.sendEnabled && cfg.scheduleConfigured),
      };
    }
    const dayDelta =
      p.ymd < targetYmd ? 1 : p.ymd > targetYmd ? -1 : 0;
    const hourDelta = cfg.hour - p.hour;
    const minuteDelta = cfg.minute - p.minute;
    guess = new Date(
      guess.getTime() +
        dayDelta * 60 * 60 * 1000 +
        hourDelta * 60 * 1000 +
        minuteDelta * 60 * 1000,
    );
  }

  return {
    ok: true,
    ...cfg,
    nextRunAt: null,
    nextRunLocal: `${targetYmd} ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")} ${cfg.timezone}`,
    schedulerArmed: Boolean(cfg.sendEnabled && cfg.scheduleConfigured),
    note: "nextRunAt_approximation_failed",
  };
}

let lastTickKey = null;
let inFlight = false;

/**
 * Called on an interval. Sends only when local clock matches configured hour:minute.
 * No boot catch-up.
 */
async function tickAuraDailyReportScheduler(dbQuery) {
  const cfg = getDailyReportScheduleConfig();
  if (!cfg.sendEnabled || !cfg.scheduleConfigured) {
    return { skipped: true, reason: !cfg.sendEnabled ? "send_disabled" : "schedule_not_configured" };
  }

  const now = new Date();
  const local = partsInTimezone(now, cfg.timezone);
  if (local.hour !== cfg.hour || local.minute !== cfg.minute) {
    return { skipped: true, reason: "outside_send_window", local };
  }

  const tickKey = `${local.ymd}-${cfg.hour}:${cfg.minute}`;
  if (lastTickKey === tickKey) {
    return { skipped: true, reason: "already_ticked_this_minute", tickKey };
  }
  if (inFlight) return { skipped: true, reason: "in_flight" };
  inFlight = true;
  lastTickKey = tickKey;

  try {
    const { generateAuraDailyReport: send } = require("./auraDailyReport.cjs");
    const out = await send(dbQuery, {
      dayYmd: local.ymd,
      dryRun: false,
      forceSend: true,
      controlledLiveSend: false,
    });
    console.log("[aura-daily-report] scheduled tick", {
      day: local.ymd,
      sent: out.sent || false,
      skippedDuplicate: out.skippedDuplicate || false,
      error: out.error || null,
    });
    return out;
  } catch (e) {
    console.warn("[aura-daily-report] scheduled tick failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  } finally {
    inFlight = false;
  }
}

function armAuraDailyReportScheduler(dbQuery) {
  const cfg = getDailyReportScheduleConfig();
  const next = getNextDailyReportRunAt();
  if (!cfg.sendEnabled) {
    console.log("[boot] AURA daily report scheduler not armed (AURA_DAILY_REPORT_ENABLED off)");
    return { armed: false, reason: "send_disabled", next };
  }
  if (!cfg.scheduleConfigured) {
    console.log(
      "[boot] AURA daily report scheduler not armed (set AURA_DAILY_REPORT_HOUR / AURA_DAILY_REPORT_MINUTE)",
    );
    return { armed: false, reason: "schedule_not_configured", next };
  }

  // Do NOT send on boot — only poll for the matching local minute.
  const intervalMs = Number(process.env.AURA_DAILY_REPORT_TICK_MS || 30_000);
  setInterval(() => {
    void tickAuraDailyReportScheduler(dbQuery);
  }, Math.max(15_000, intervalMs));

  console.log("[boot] AURA daily report scheduler armed", {
    timezone: cfg.timezone,
    hour: cfg.hour,
    minute: cfg.minute,
    recipient: cfg.recipient,
    nextRunLocal: next.nextRunLocal,
    tickMs: Math.max(15_000, intervalMs),
  });
  return { armed: true, next, cfg };
}

module.exports = {
  parseHourMinute,
  partsInTimezone,
  getDailyReportScheduleConfig,
  getNextDailyReportRunAt,
  tickAuraDailyReportScheduler,
  armAuraDailyReportScheduler,
};
