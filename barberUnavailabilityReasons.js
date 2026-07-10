/** Client-facing unavailability reasons when a provider blocks a date. */

export const DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE =
  "This provider is unavailable at this time. Please choose another available appointment.";

export const UNAVAILABILITY_REASON_CODES = [
  "day_off",
  "vacation",
  "fully_booked",
  "holiday",
  "sick_leave",
  "personal_appointment",
  "training",
  "out_of_office",
  "temporarily_unavailable",
  "custom",
];

/** Provider-facing labels (schedule editor). */
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
];

export function normalizeClientReason(raw) {
  const code = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!code) return null;
  return UNAVAILABILITY_REASON_CODES.includes(code) ? code : null;
}

export function normalizeReturnDate(raw) {
  const s = String(raw || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function sanitizeClientMessage(raw) {
  const msg = String(raw || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 280);
  return msg || null;
}

export function formatReturnDateLabel(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Build the message clients see for a blocked date.
 * Never includes private `note` — only client_reason, return_date, client_message.
 */
export function buildClientUnavailability(meta) {
  const reason = normalizeClientReason(meta?.client_reason ?? meta?.clientReason);
  const returnDate = normalizeReturnDate(meta?.return_date ?? meta?.returnDate);
  const customMessage = sanitizeClientMessage(meta?.client_message ?? meta?.clientMessage);

  if (reason === "custom" && customMessage) {
    return { message: customMessage, reason, returnDate };
  }

  const returnLabel = formatReturnDateLabel(returnDate);
  let message = DEFAULT_CLIENT_UNAVAILABILITY_MESSAGE;

  switch (reason) {
    case "day_off":
      message = "This provider is off today. Please choose another available date.";
      break;
    case "vacation":
      message = returnLabel
        ? `This provider is on vacation and will return on ${returnLabel}.`
        : "This provider is on vacation. Please choose another available date.";
      break;
    case "fully_booked":
      message =
        "This provider is fully booked today. Please select another available appointment.";
      break;
    case "holiday":
      message = "This provider is unavailable due to a holiday.";
      break;
    case "sick_leave":
      message = returnLabel
        ? `This provider is unavailable and expects to return on ${returnLabel}. Please choose another available date.`
        : "This provider is unavailable today. Please choose another available date.";
      break;
    case "personal_appointment":
      message =
        "This provider is unavailable at this time. Please choose another available appointment.";
      break;
    case "training":
      message = returnLabel
        ? `This provider is unavailable due to training and will return on ${returnLabel}.`
        : "This provider is unavailable due to training. Please choose another available date.";
      break;
    case "out_of_office":
      message = returnLabel
        ? `This provider is out of office and will return on ${returnLabel}.`
        : "This provider is out of office. Please choose another available date.";
      break;
    case "temporarily_unavailable":
      message = returnLabel
        ? `This provider is temporarily unavailable and will return on ${returnLabel}.`
        : "This provider is temporarily unavailable. Please choose another available appointment.";
      break;
    default:
      break;
  }

  return { message, reason: reason || null, returnDate };
}
