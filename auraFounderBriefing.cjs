/**
 * Live founder operational briefing from production bookings.
 * Never invents bookings, revenue, or calendar events.
 */
const { shopTimezone, queryAvailability, listBookableBarbers } = require("./auraVoiceIntelligenceBooking.cjs");
const { getFounderState } = require("./auraFounderAudit.cjs");

const TZ = () => shopTimezone() || "America/New_York";

function safeRows(r) {
  return Array.isArray(r?.rows) ? r.rows : [];
}

function formatTimeLabel(t) {
  if (t == null) return "";
  const s = String(t);
  // Postgres time often "09:00:00"
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const mi = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${String(h).padStart(2, "0")}:${mi} ${ap}`;
}

function fallbackTodayYmd(timezone = TZ()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

async function todayYmd(timezone = TZ()) {
  try {
    const engine = await import("./barberSlotEngine.js");
    if (typeof engine.todayYmdInTimezone === "function") {
      return engine.todayYmdInTimezone(timezone);
    }
  } catch {
    /* fallback */
  }
  return fallbackTodayYmd(timezone);
}

async function nowPartsInTz(timezone = TZ()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return {
    ymd: await todayYmd(timezone),
    spoken: fmt.format(new Date()),
    timezone,
  };
}

function statusBucket(row) {
  const s = String(row.booking_status || "").toLowerCase();
  if (["canceled", "cancelled"].includes(s)) return "cancelled";
  if (s === "completed") return "completed";
  if (s === "confirmed" || s === "approved") return "confirmed";
  if (s === "rescheduled") return "rescheduled";
  return "pending";
}

function isPaidStatus(ps) {
  return ["paid", "paid_in_full", "captured", "completed"].includes(String(ps || "").toLowerCase());
}

async function loadTodayAppointments(dbQuery, ymd) {
  try {
    const r = await dbQuery(
      `SELECT id, customer_name, phone, service, barber_name, barber_id,
              date, time, booking_status, payment_status,
              coalesce(total_price, amount, service_price, 0)::float8 AS price,
              coalesce(amount_paid, total_paid, 0)::float8 AS amount_paid,
              created_at, cancelled_at, cancellation_reason,
              completed_at, service_duration_minutes
       FROM bookings
       WHERE deleted_at IS NULL
         AND date::date = $1::date
       ORDER BY time ASC NULLS LAST, created_at ASC`,
      [ymd],
    );
    return { ok: true, rows: safeRows(r) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), rows: [] };
  }
}

async function loadTodayCreatedReschedulesCancels(dbQuery, ymd) {
  const out = { rescheduled: [], cancelled: [], sourceErrors: [] };
  try {
    const canc = await dbQuery(
      `SELECT id, customer_name, service, barber_name, date, time, booking_status,
              payment_status, cancellation_reason, cancelled_at, created_at
       FROM bookings
       WHERE (
           lower(coalesce(booking_status,'')) IN ('canceled','cancelled')
           OR cancelled_at IS NOT NULL
         )
         AND (
           date::date = $1::date
           OR cancelled_at::date = $1::date
           OR created_at::date = $1::date
         )
       ORDER BY coalesce(cancelled_at, created_at) DESC NULLS LAST
       LIMIT 40`,
      [ymd],
    );
    out.cancelled = safeRows(canc);
  } catch (e) {
    out.sourceErrors.push({ source: "cancellations", error: e?.message || String(e) });
  }

  try {
    const hist = await dbQuery(
      `SELECT h.booking_id, h.previous_status, h.new_status, h.note, h.created_at,
              b.customer_name, b.service, b.barber_name, b.date, b.time
       FROM booking_status_history h
       LEFT JOIN bookings b ON b.id = h.booking_id
       WHERE h.created_at::date = $1::date
         AND (
           lower(coalesce(h.new_status,'')) LIKE '%resched%'
           OR lower(coalesce(h.note,'')) LIKE '%resched%'
           OR lower(coalesce(h.note,'')) LIKE '%moved%'
         )
       ORDER BY h.created_at DESC
       LIMIT 40`,
      [ymd],
    );
    out.rescheduled = safeRows(hist);
  } catch (e) {
    // history table may be absent — soft skip, not a briefing failure
    if (!/does not exist/i.test(String(e?.message || e))) {
      out.sourceErrors.push({ source: "reschedule_history", error: e?.message || String(e) });
    }
  }
  return out;
}

async function loadOpenEscalations(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT id, created_at, from_e164, caller_name, reason, status, appointment_ref
       FROM aura_voice_escalations
       WHERE lower(coalesce(status,'open')) IN ('open','pending')
       ORDER BY created_at DESC
       LIMIT 15`,
    );
    return { ok: true, rows: safeRows(r) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), rows: [] };
  }
}

async function loadFailedPaymentsToday(dbQuery, ymd) {
  try {
    const r = await dbQuery(
      `SELECT id, customer_name, service, barber_name, date, time, payment_status, booking_status,
              coalesce(total_price, amount, 0)::float8 AS price, created_at
       FROM bookings
       WHERE deleted_at IS NULL
         AND (
           lower(coalesce(payment_status,'')) IN ('failed','denied','error','declined')
           OR (lower(coalesce(booking_status,'')) IN ('pending','incomplete') AND created_at::date = $1::date)
         )
         AND (created_at::date = $1::date OR date::date = $1::date)
       ORDER BY created_at DESC NULLS LAST
       LIMIT 25`,
      [ymd],
    );
    return { ok: true, rows: safeRows(r) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), rows: [] };
  }
}

async function summarizeOpenSlots(dbQuery, ymd) {
  try {
    const barbers = await listBookableBarbers(dbQuery);
    if (!Array.isArray(barbers)) {
      return { ok: false, error: "barbers_unavailable", totalOpen: null, byBarber: [], unavailable: [] };
    }
    let totalOpen = 0;
    const byBarber = [];
    const unavailable = [];
    for (const b of barbers) {
      const avail = await queryAvailability(dbQuery, {
        barberId: b.id,
        barberName: b.name,
        dateYmd: ymd,
        durationMinutes: 30,
      });
      const n = avail?.ok ? (avail.openSlots || []).length : 0;
      if (!avail?.ok || n === 0) {
        unavailable.push({
          barberId: b.id,
          barberName: b.name,
          reason: avail?.reasonIfEmpty || avail?.error || "no_open_slots",
        });
      }
      totalOpen += n;
      byBarber.push({ barberId: b.id, barberName: b.name, openCount: n });
    }
    return { ok: true, totalOpen, byBarber, unavailable, activeBarbers: barbers.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), totalOpen: null, byBarber: [], unavailable: [] };
  }
}

function googleCalendarStatus() {
  // No Google Calendar OAuth / sync is wired in this backend today.
  const connected = Boolean(
    String(process.env.GOOGLE_CALENDAR_CONNECTED || "").trim() === "1" ||
      String(process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || "").trim(),
  );
  return {
    connected,
    events: [],
    spokenUnavailable:
      "Your personal calendar is not connected yet, but I can provide the complete I F C D C Barbers App operational schedule.",
  };
}

async function buildFounderOperationalBriefing(dbQuery, { sinceIso } = {}) {
  const now = await nowPartsInTz();
  const ymd = now.ymd;
  const sourcesFailed = [];

  const appts = await loadTodayAppointments(dbQuery, ymd);
  if (!appts.ok) sourcesFailed.push({ source: "bookings_today", error: appts.error });

  const churn = await loadTodayCreatedReschedulesCancels(dbQuery, ymd);
  sourcesFailed.push(...(churn.sourceErrors || []));

  const escalations = await loadOpenEscalations(dbQuery);
  if (!escalations.ok) sourcesFailed.push({ source: "escalations", error: escalations.error });

  const failedPay = await loadFailedPaymentsToday(dbQuery, ymd);
  if (!failedPay.ok) sourcesFailed.push({ source: "failed_payments", error: failedPay.error });

  const slots = await summarizeOpenSlots(dbQuery, ymd);
  if (!slots.ok) sourcesFailed.push({ source: "open_slots", error: slots.error });

  const calendar = googleCalendarStatus();

  const appointments = appts.rows.map((row) => ({
    id: row.id,
    timeLabel: formatTimeLabel(row.time),
    customerName: row.customer_name || "Customer",
    barberName: row.barber_name || "Unassigned",
    service: row.service || "Service",
    durationMinutes: row.service_duration_minutes != null ? Number(row.service_duration_minutes) : null,
    paymentStatus: row.payment_status || "unknown",
    bookingStatus: row.booking_status || "unknown",
    price: Number(row.price) || 0,
    amountPaid: Number(row.amount_paid) || 0,
    bucket: statusBucket(row),
  }));

  const buckets = {
    total: appointments.length,
    confirmed: appointments.filter((a) => a.bucket === "confirmed").length,
    pending: appointments.filter((a) => a.bucket === "pending").length,
    completed: appointments.filter((a) => a.bucket === "completed").length,
    cancelled: appointments.filter((a) => a.bucket === "cancelled").length,
    rescheduled: churn.rescheduled.length,
  };

  const revenueCollected = appointments
    .filter((a) => isPaidStatus(a.paymentStatus) || a.amountPaid > 0)
    .reduce((sum, a) => sum + (a.amountPaid > 0 ? a.amountPaid : a.price), 0);
  const paymentsPending = appointments.filter(
    (a) => a.bucket !== "cancelled" && !isPaidStatus(a.paymentStatus) && !(a.amountPaid > 0),
  ).length;

  let changes = null;
  if (sinceIso) {
    changes = await loadChangesSince(dbQuery, sinceIso);
    if (!changes.ok) sourcesFailed.push({ source: "changes_since", error: changes.error });
  }

  // Busiest barber today by appointment count
  const byBarberCount = new Map();
  for (const a of appointments) {
    if (a.bucket === "cancelled") continue;
    byBarberCount.set(a.barberName, (byBarberCount.get(a.barberName) || 0) + 1);
  }
  let busiest = null;
  for (const [name, n] of byBarberCount) {
    if (!busiest || n > busiest.count) busiest = { barberName: name, count: n };
  }

  const activeToday = appointments.filter((a) => a.bucket !== "cancelled");
  const firstCustomer = activeToday[0] || null;
  const nextAppt = (() => {
    const nowMin = (() => {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: TZ(),
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(new Date());
        const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
        const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
        return h * 60 + m;
      } catch {
        return null;
      }
    })();
    if (nowMin == null) return activeToday[0] || null;
    for (const a of activeToday) {
      const m = String(a.timeLabel).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) continue;
      let h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      const ap = m[3].toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      if (h * 60 + mi >= nowMin) return a;
    }
    return null;
  })();

  return {
    ok: sourcesFailed.every((s) => s.source !== "bookings_today"),
    now,
    personalCalendar: calendar,
    operational: {
      appointments,
      cancelledToday: churn.cancelled,
      rescheduledToday: churn.rescheduled,
      escalations: escalations.rows,
      failedPayments: failedPay.rows,
      openSlots: slots,
      executive: {
        ...buckets,
        revenueCollected,
        paymentsPending,
        activeBarbers: slots.activeBarbers ?? null,
        availableSlots: slots.totalOpen,
        customerIssues: escalations.rows.length + failedPay.rows.length,
        busiest,
        firstCustomer,
        nextAppointment: nextAppt,
      },
    },
    changes,
    sourcesFailed,
  };
}

async function loadChangesSince(dbQuery, sinceIso) {
  try {
    const since = new Date(sinceIso);
    if (Number.isNaN(since.getTime())) {
      return { ok: false, error: "invalid_since", events: [] };
    }
    const r = await dbQuery(
      `SELECT * FROM aura_founder_events
       WHERE created_at > $1::timestamptz
       ORDER BY created_at ASC
       LIMIT 80`,
      [since.toISOString()],
    );
    const events = safeRows(r);

    // Also pull bookings mutated since last call (live DB), even if event log empty.
    const bookings = await dbQuery(
      `SELECT id, customer_name, service, barber_name, date, time, booking_status, payment_status,
              created_at, cancelled_at, cancellation_reason
       FROM bookings
       WHERE deleted_at IS NULL
         AND (
           created_at > $1::timestamptz
           OR cancelled_at > $1::timestamptz
         )
       ORDER BY coalesce(cancelled_at, created_at) ASC
       LIMIT 80`,
      [since.toISOString()],
    );

    return {
      ok: true,
      since: since.toISOString(),
      events,
      bookingsTouched: safeRows(bookings),
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), events: [], bookingsTouched: [] };
  }
}

function speakAppointmentLine(a) {
  return `${a.timeLabel}: ${a.customerName} with ${a.barberName} for ${a.service}. Status ${a.bookingStatus}, payment ${a.paymentStatus}.`;
}

/**
 * Spoken founder briefing — urgent issues first; no invented details.
 */
function speakFounderBriefing(brief, { mode = "full" } = {}) {
  if (!brief) {
    return "I cannot load live operational records right now. No schedule details were invented.";
  }
  const parts = [];
  const { now, personalCalendar, operational, sourcesFailed } = brief;
  parts.push(`Today is ${now.spoken} Eastern.`);

  if (!personalCalendar.connected) {
    parts.push(personalCalendar.spokenUnavailable);
  } else {
    parts.push("Your personal calendar is connected, but no merged personal events were returned.");
  }

  parts.push("Here is the I F C D C Barbers App operational schedule.");

  const ex = operational.executive;
  const urgent = [];
  if (operational.escalations?.length) {
    urgent.push(
      `${operational.escalations.length} customer issue${operational.escalations.length === 1 ? "" : "s"} needing attention.`,
    );
  }
  if (operational.failedPayments?.length) {
    urgent.push(
      `${operational.failedPayments.length} failed or incomplete payment record${operational.failedPayments.length === 1 ? "" : "s"}.`,
    );
  }
  if (urgent.length) {
    parts.push(`Urgent first: ${urgent.join(" ")}`);
  }

  parts.push(
    `Executive summary: ${ex.total} appointments today — ${ex.confirmed} confirmed, ${ex.pending} pending, ${ex.completed} completed, ${ex.cancelled} cancelled, ${ex.rescheduled} reschedule notes. Revenue collected on record today is ${Math.round(ex.revenueCollected)} dollars. ${ex.paymentsPending} payments still pending. ${ex.activeBarbers == null ? "Active barber count unavailable." : `${ex.activeBarbers} active barbers.`} ${ex.availableSlots == null ? "Open slot count unavailable." : `${ex.availableSlots} open slots remaining.`}`,
  );

  if (mode === "summary") {
    if (sourcesFailed?.length) {
      parts.push(
        `Some sources failed: ${sourcesFailed.map((s) => s.source).join(", ")}. I only reported verified data.`,
      );
    }
    return parts.join(" ");
  }

  if (ex.firstCustomer) {
    parts.push(`First customer today: ${speakAppointmentLine(ex.firstCustomer)}`);
  }
  if (ex.nextAppointment) {
    parts.push(`Next appointment: ${speakAppointmentLine(ex.nextAppointment)}`);
  }
  if (ex.busiest) {
    parts.push(`Busiest barber today: ${ex.busiest.barberName} with ${ex.busiest.count} appointments.`);
  }

  const active = (operational.appointments || []).filter((a) => a.bucket !== "cancelled");
  if (!active.length) {
    parts.push("There are no active appointments on the calendar for today.");
  } else {
    const max = mode === "activity" ? 12 : 8;
    parts.push(`Chronological appointments: ${active.slice(0, max).map(speakAppointmentLine).join(" ")}`);
    if (active.length > max) parts.push(`Plus ${active.length - max} more on the calendar.`);
  }

  if (operational.cancelledToday?.length) {
    parts.push(
      `Recent cancellations: ${operational.cancelledToday
        .slice(0, 5)
        .map(
          (c) =>
            `${c.customer_name || "Customer"} at ${formatTimeLabel(c.time)}${c.cancellation_reason ? `, reason ${c.cancellation_reason}` : ""}`,
        )
        .join("; ")}.`,
    );
  }
  if (operational.rescheduledToday?.length) {
    parts.push(`Reschedule activity recorded today: ${operational.rescheduledToday.length} entries.`);
  }
  if (operational.openSlots?.unavailable?.length) {
    parts.push(
      `Barbers with no open slots or unavailable today: ${operational.openSlots.unavailable
        .slice(0, 5)
        .map((u) => u.barberName)
        .join(", ")}.`,
    );
  }

  if (sourcesFailed?.length) {
    parts.push(
      `Data caveat: ${sourcesFailed.map((s) => `${s.source} unavailable`).join("; ")}. I did not invent missing data.`,
    );
  }

  const actions = [];
  if (operational.escalations?.length) actions.push("review open customer escalations");
  if (ex.paymentsPending > 0) actions.push("follow pending payments");
  if (operational.failedPayments?.length) actions.push("inspect failed payment records");
  if (actions.length) parts.push(`Recommended founder actions: ${actions.join("; ")}.`);

  return parts.join(" ");
}

function speakChangesSince(brief) {
  const changes = brief?.changes;
  if (!changes?.ok) {
    return "I could not load change history since your last briefing from live records.";
  }
  const events = changes.events || [];
  const touched = changes.bookingsTouched || [];
  if (!events.length && !touched.length) {
    return "Nothing new has changed in live operational records since your last briefing.";
  }
  const parts = [`Since your last briefing at ${changes.since}:`];
  if (events.length) {
    parts.push(
      `${events.length} founder event${events.length === 1 ? "" : "s"}: ${events
        .slice(0, 10)
        .map((e) => {
          const who = e.customer_name || "customer";
          return `${e.event_type} for ${who}${e.service_name ? `, ${e.service_name}` : ""}`;
        })
        .join("; ")}.`,
    );
  }
  if (touched.length) {
    parts.push(
      `${touched.length} booking record${touched.length === 1 ? "" : "s"} created or updated: ${touched
        .slice(0, 8)
        .map((b) => `${b.customer_name || "Customer"} ${b.booking_status || ""} ${b.payment_status || ""}`.trim())
        .join("; ")}.`,
    );
  }
  return parts.join(" ");
}

async function resolveLastBriefingSince(dbQuery) {
  const state = await getFounderState(dbQuery);
  return state?.last_briefing_at ? new Date(state.last_briefing_at).toISOString() : null;
}

module.exports = {
  nowPartsInTz,
  buildFounderOperationalBriefing,
  loadChangesSince,
  speakFounderBriefing,
  speakChangesSince,
  resolveLastBriefingSince,
  googleCalendarStatus,
  formatTimeLabel,
};
