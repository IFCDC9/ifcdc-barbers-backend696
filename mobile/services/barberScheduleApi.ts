import { apiFetch } from "./api";

export type AvailabilityRow = {
  id?: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_off: boolean;
};

export type BreakRow = {
  id?: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
};

export type BlockedDateRow = {
  id?: number;
  blocked_date: string;
  note?: string | null;
  client_reason?: string | null;
  return_date?: string | null;
  client_message?: string | null;
};

export type BarberSchedule = {
  barberId?: string | number;
  availability: AvailabilityRow[];
  breaks: BreakRow[];
  blockedDates: BlockedDateRow[];
  appointment_interval_minutes: number;
  timezone: string;
  booking_window_days?: number;
};

export type BarberListRow = {
  id: string | number;
  name?: string;
  phone?: string | null;
  user_id?: string | null;
};

type ScheduleApiJson = {
  success?: boolean;
  barberId?: string | number;
  availability?: AvailabilityRow[];
  breaks?: BreakRow[];
  blockedDates?: BlockedDateRow[];
  appointmentInterval?: number;
  appointment_interval_minutes?: number;
  timezone?: string;
  booking_window_days?: number;
  bookingWindowDays?: number;
  message?: string;
  error?: string;
};

function scheduleQuery(barberId: string | number) {
  const id = encodeURIComponent(String(barberId));
  return `/api/barber/schedule?barberId=${id}`;
}

function normalizeSchedule(json: ScheduleApiJson): BarberSchedule {
  return {
    barberId: json.barberId,
    availability: Array.isArray(json.availability) ? json.availability : [],
    breaks: Array.isArray(json.breaks) ? json.breaks : [],
    blockedDates: Array.isArray(json.blockedDates) ? json.blockedDates : [],
    appointment_interval_minutes:
      Number(json.appointmentInterval ?? json.appointment_interval_minutes) || 30,
    timezone: String(json.timezone || "America/New_York"),
    booking_window_days: Number(json.bookingWindowDays ?? json.booking_window_days) || 90,
  };
}

export async function fetchBarberList(): Promise<BarberListRow[]> {
  const res = await apiFetch("/api/barber/list");
  const json = (await res.json()) as { barbers?: BarberListRow[]; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || `Barber list failed (${res.status})`);
  }
  return Array.isArray(json.barbers) ? json.barbers : [];
}

export async function fetchBarberSchedule(barberId: string | number): Promise<BarberSchedule> {
  const res = await apiFetch(scheduleQuery(barberId));
  const json = (await res.json()) as ScheduleApiJson;
  if (!res.ok || json.success === false) {
    throw new Error("schedule_unavailable");
  }
  return normalizeSchedule(json);
}

export async function saveBarberSchedule(
  barberId: string | number,
  body: {
    availability: Array<{
      day_of_week: number;
      start_time: string;
      end_time: string;
      is_off: boolean;
    }>;
    breaks: BreakRow[];
    blockedDates: Array<{ blocked_date: string; note?: string }>;
    appointment_interval_minutes: number;
    timezone: string;
  },
): Promise<BarberSchedule> {
  const res = await apiFetch(scheduleQuery(barberId), {
    method: "PUT",
    body: JSON.stringify({
      ...body,
      appointmentInterval: body.appointment_interval_minutes,
    }),
  });
  const json = (await res.json()) as ScheduleApiJson;
  if (!res.ok || json.success === false) {
    throw new Error(json.message || json.error || "Schedule save failed");
  }
  return normalizeSchedule(json);
}
