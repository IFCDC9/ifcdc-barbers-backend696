/**
 * AURA Phase 2 side-effect hooks — all gated by feature flags.
 * Never throws to callers (best-effort).
 */
const { auraPhase2Flags } = require("./auraPhase2Flags.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

function safeRequireEmails() {
  return require("./auraPhase2Emails.cjs");
}

function safeRequireNotify() {
  return require("./auraPhase2Notify.cjs");
}

async function afterBookingCancelled(dbQuery, booking, { reason } = {}) {
  const flags = auraPhase2Flags();
  if (!flags.master || !booking?.id) return { skipped: true };
  const results = {};

  try {
    const emails = safeRequireEmails();
    results.customer = await emails.sendAuraCancelEmail({
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      barberName: booking.barber_name,
      service: booking.service || booking.style_title,
      date: booking.date,
      time: booking.time,
      price: booking.total_paid ?? booking.amount_paid ?? booking.total_price,
      bookingId: booking.id,
    });
  } catch (e) {
    results.customer = { ok: false, error: e?.message || String(e) };
  }

  if (flags.barberNotify) {
    try {
      results.barber = await safeRequireNotify().notifyBarberBookingEvent(dbQuery, booking, "cancelled");
    } catch (e) {
      results.barber = { ok: false, error: e?.message || String(e) };
    }
  }

  await logAuraAction(dbQuery, {
    action: "hook_cancel",
    bookingId: booking.id,
    result: results.customer?.ok ? "ok" : "partial",
    metadata: { reason: reason || null, results },
  });
  return results;
}

async function afterBookingRescheduled(dbQuery, booking, { fromLabel, newDate, newTime } = {}) {
  const flags = auraPhase2Flags();
  if (!flags.master || !booking?.id) return { skipped: true };
  const results = {};

  // Customer already gets confirmation via sendBookingEmail on the reschedule route.
  // Extra AURA-branded reschedule email only when AURA_PHASE2_RESCHEDULE_EMAIL=1.
  if (flags.rescheduleEmailExtra) {
    try {
      const emails = safeRequireEmails();
      results.customer = await emails.sendAuraRescheduleEmail({
        customerName: booking.customer_name,
        customerEmail: booking.customer_email,
        barberName: booking.barber_name,
        service: booking.service || booking.style_title,
        date: newDate || booking.date,
        time: newTime || booking.time,
        price: booking.total_paid ?? booking.amount_paid ?? booking.total_price,
        bookingId: booking.id,
        fromLabel: fromLabel || "",
      });
    } catch (e) {
      results.customer = { ok: false, error: e?.message || String(e) };
    }
  }

  if (flags.barberNotify) {
    try {
      results.barber = await safeRequireNotify().notifyBarberBookingEvent(
        dbQuery,
        {
          ...booking,
          date: newDate || booking.date,
          time: newTime || booking.time,
        },
        "rescheduled",
      );
    } catch (e) {
      results.barber = { ok: false, error: e?.message || String(e) };
    }
  }

  await logAuraAction(dbQuery, {
    action: "hook_reschedule",
    bookingId: booking.id,
    result: "ok",
    metadata: { fromLabel: fromLabel || null, results },
  });
  return results;
}

async function afterBookingCreated(dbQuery, booking) {
  const flags = auraPhase2Flags();
  if (!flags.master || !booking?.id) return { skipped: true };
  const results = {};

  if (flags.barberNotify) {
    try {
      results.barber = await safeRequireNotify().notifyBarberBookingEvent(dbQuery, booking, "created");
    } catch (e) {
      results.barber = { ok: false, error: e?.message || String(e) };
    }
  }

  await logAuraAction(dbQuery, {
    action: "hook_created",
    bookingId: booking.id,
    result: results.barber?.ok ? "ok" : flags.barberNotify ? "failed" : "noop",
    metadata: { results },
  });
  return results;
}

async function afterBookingCompleted(dbQuery, booking, { loyalty } = {}) {
  const flags = auraPhase2Flags();
  if (!flags.reviewFollowup || !booking?.id) return { skipped: true };

  const status = String(booking.booking_status || "").toLowerCase();
  if (["cancelled", "canceled", "no_show", "noshow"].includes(status)) {
    return { skipped: true, reason: "status_excluded" };
  }

  let rewardsProgress = null;
  try {
    if (booking.user_id) {
      const { getLoyaltyDashboard } = await import("./loyaltyService.js");
      const dash = await getLoyaltyDashboard(String(booking.user_id));
      const pts = Number(dash?.account?.points_balance ?? dash?.points ?? 0);
      if (Number.isFinite(pts)) rewardsProgress = `${pts} reward points`;
    }
  } catch {
    /* optional */
  }
  if (!rewardsProgress && loyalty?.points != null) {
    rewardsProgress = `${loyalty.points} points earned this visit`;
  }

  try {
    const emails = safeRequireEmails();
    const out = await emails.sendAuraReviewFollowupEmail({
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      service: booking.service || booking.style_title,
      bookingId: booking.id,
      rewardsProgress,
    });
    await logAuraAction(dbQuery, {
      action: "review_followup",
      bookingId: booking.id,
      result: out.ok ? "sent" : "failed",
      metadata: { error: out.error || null },
    });
    return out;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function alertFailureBestEffort(dbQuery, kind, detail) {
  const flags = auraPhase2Flags();
  if (!flags.adminAlerts) return { skipped: true };
  try {
    return await safeRequireNotify().alertSuperAdminFailure(dbQuery, kind, detail);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  afterBookingCancelled,
  afterBookingRescheduled,
  afterBookingCreated,
  afterBookingCompleted,
  alertFailureBestEffort,
};
