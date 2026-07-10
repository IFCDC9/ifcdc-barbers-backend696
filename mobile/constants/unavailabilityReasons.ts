/** Provider schedule editor — client-facing unavailability reason options. */
export const UNAVAILABILITY_REASON_OPTIONS = [
  { code: "", label: "Default message (no specific reason)" },
  { code: "day_off", label: "Day Off" },
  { code: "vacation", label: "On Vacation" },
  { code: "fully_booked", label: "Fully Booked" },
  { code: "holiday", label: "Holiday" },
  { code: "sick_leave", label: "Sick Leave" },
  { code: "personal_appointment", label: "Personal Appointment" },
  { code: "training", label: "Training / Continuing Education" },
  { code: "out_of_office", label: "Out of Office" },
  { code: "temporarily_unavailable", label: "Temporarily Unavailable" },
  { code: "custom", label: "Custom Client Message" },
] as const;

export type UnavailabilityReasonCode = (typeof UNAVAILABILITY_REASON_OPTIONS)[number]["code"];
