import { WEEKDAYS } from "../constants/scheduleDays";
import type { BarberSchedule, BreakRow } from "../services/barberScheduleApi";

export type DaySchedule = {
  day_of_week: number;
  enabled: boolean;
  start_time: string;
  end_time: string;
};

export type EditScheduleState = {
  days: DaySchedule[];
  breaks: BreakRow[];
  blockedDates: Array<{
    blocked_date: string;
    note: string;
    client_reason: string;
    return_date: string;
    client_message: string;
  }>;
  appointment_interval_minutes: number;
  timezone: string;
  booking_window_days: number;
};

const DEFAULT_START = "09:00";
const DEFAULT_END = "00:30";

/** Defaults when no schedule exists or API load fails — all days on, 9:00 AM–12:30 AM. */
export function defaultEditScheduleState(): EditScheduleState {
  return {
    days: WEEKDAYS.map(({ dow }) => ({
      day_of_week: dow,
      enabled: true,
      start_time: DEFAULT_START,
      end_time: DEFAULT_END,
    })),
    breaks: [],
    blockedDates: [],
    appointment_interval_minutes: 30,
    timezone: "America/New_York",
    booking_window_days: 90,
  };
}

export function scheduleToEditState(schedule: BarberSchedule): EditScheduleState {
  const base = defaultEditScheduleState();
  const byDay = new Map<number, { start_time: string; end_time: string; is_off: boolean }>();
  for (const row of schedule.availability) {
    const dow = Number(row.day_of_week);
    byDay.set(dow, {
      start_time: String(row.start_time || DEFAULT_START).slice(0, 5),
      end_time: String(row.end_time || DEFAULT_END).slice(0, 5),
      is_off: Boolean(row.is_off),
    });
  }
  base.days = WEEKDAYS.map(({ dow }) => {
    const hit = byDay.get(dow);
    if (!hit) {
      return { day_of_week: dow, enabled: false, start_time: DEFAULT_START, end_time: DEFAULT_END };
    }
    return {
      day_of_week: dow,
      enabled: !hit.is_off,
      start_time: hit.start_time,
      end_time: hit.end_time,
    };
  });
  base.breaks = (schedule.breaks || []).map((b) => ({
    day_of_week: Number(b.day_of_week),
    start_time: String(b.start_time || "").slice(0, 5),
    end_time: String(b.end_time || "").slice(0, 5),
  }));
  base.blockedDates = (schedule.blockedDates || []).map((b) => ({
    blocked_date: String(b.blocked_date || "").slice(0, 10),
    note: String(b.note || ""),
    client_reason: String(b.client_reason || ""),
    return_date: String(b.return_date || "").slice(0, 10),
    client_message: String(b.client_message || ""),
  }));
  base.appointment_interval_minutes = Number(schedule.appointment_interval_minutes) || 30;
  base.timezone = String(schedule.timezone || "America/New_York");
  base.booking_window_days = Number(schedule.booking_window_days) || 90;
  return base;
}

export function editStateToSavePayload(state: EditScheduleState) {
  return {
    availability: state.days.map((d) => ({
      day_of_week: d.day_of_week,
      start_time: d.start_time,
      end_time: d.end_time,
      is_off: !d.enabled,
    })),
    breaks: state.breaks.map((b) => ({
      day_of_week: b.day_of_week,
      start_time: b.start_time,
      end_time: b.end_time,
    })),
    blockedDates: state.blockedDates
      .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.blocked_date))
      .map((b) => ({
        blocked_date: b.blocked_date,
        note: b.note || undefined,
        client_reason: b.client_reason || undefined,
        return_date: b.return_date || undefined,
        client_message: b.client_reason === "custom" ? b.client_message || undefined : undefined,
      })),
    appointment_interval_minutes: state.appointment_interval_minutes,
    timezone: state.timezone.trim() || "America/New_York",
    booking_window_days: state.booking_window_days || 90,
  };
}

export function summarizeSchedule(schedule: BarberSchedule): {
  workingDays: string;
  hours: string;
  breaks: string;
  blocked: string;
  interval: string;
  timezone: string;
} {
  const open = schedule.availability.filter((a) => !a.is_off);
  const dayNums = [...new Set(open.map((a) => Number(a.day_of_week)))].sort((a, b) => a - b);
  const workingDays =
    dayNums.length === 0
      ? "None"
      : dayNums.map((d) => WEEKDAYS.find((w) => w.dow === d)?.short ?? "?").join(", ");

  let hours = "—";
  if (open.length) {
    const starts = open.map((a) => String(a.start_time).slice(0, 5));
    const ends = open.map((a) => String(a.end_time).slice(0, 5));
    const minStart = starts.sort()[0];
    const maxEnd = ends.sort().slice(-1)[0];
    hours = `${minStart} – ${maxEnd}`;
  }

  const breaks =
    schedule.breaks.length === 0
      ? "None"
      : schedule.breaks
          .map((b) => `${WEEKDAYS.find((w) => w.dow === Number(b.day_of_week))?.short ?? "?"} ${String(b.start_time).slice(0, 5)}–${String(b.end_time).slice(0, 5)}`)
          .join("; ");

  const blocked =
    schedule.blockedDates.length === 0
      ? "None"
      : schedule.blockedDates.map((b) => b.blocked_date).join(", ");

  return {
    workingDays,
    hours,
    breaks,
    blocked,
    interval: `${schedule.appointment_interval_minutes || 30} min`,
    timezone: schedule.timezone || "America/New_York",
  };
}

export function isValidTimeHHMM(value: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(String(value || "").trim());
}
