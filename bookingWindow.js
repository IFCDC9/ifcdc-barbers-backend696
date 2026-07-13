/** Allowed advance-booking windows (days from today in barber timezone). */
export const BOOKING_WINDOW_DAY_OPTIONS = [
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "12 months" },
];

export const DEFAULT_BOOKING_WINDOW_DAYS = 90;

export function normalizeBookingWindowDays(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_BOOKING_WINDOW_DAYS;
  const allowed = BOOKING_WINDOW_DAY_OPTIONS.map((o) => o.days);
  if (allowed.includes(n)) return n;
  // Clamp unknown values into a sensible range
  return Math.max(7, Math.min(365, n || DEFAULT_BOOKING_WINDOW_DAYS));
}
