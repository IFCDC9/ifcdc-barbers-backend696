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
  const results = {};
  if (!booking?.id) return { skipped: true };

  // SMS cancel — independent of AURA Phase 2 master; gated by SMS_NOTIFICATIONS_ENABLED.
  try {
    const { notifyBookingSms } = require("./smsBookingNotify.cjs");
    results.sms = await notifyBookingSms(dbQuery, "booking_canceled", booking, {
      occurrence: "cancel",
    });
  } catch (e) {
    results.sms = { ok: false, error: e?.message || String(e) };
  }

  const flags = auraPhase2Flags();
  if (!flags.master) return { ...results, skippedAura: true };

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
  const results = {};
  if (!booking?.id) return { skipped: true };

  try {
    const { notifyBookingSms } = require("./smsBookingNotify.cjs");
    results.sms = await notifyBookingSms(
      dbQuery,
      "booking_rescheduled",
      {
        ...booking,
        date: newDate || booking.date,
        time: newTime || booking.time,
      },
      { occurrence: `reschedule:${String(newDate || "")}:${String(newTime || "")}` },
    );
  } catch (e) {
    results.sms = { ok: false, error: e?.message || String(e) };
  }

  const flags = auraPhase2Flags();
  if (!flags.master) return { ...results, skippedAura: true };

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

async function afterBookingCreated(dbQuery, booking, { skipSms = false } = {}) {
  const results = {};
  if (!booking?.id) return { skipped: true };

  // Paid app checkout sends booking_approved separately — skip to avoid duplicate SMS.
  if (!skipSms) {
    try {
      const { notifyBookingSms } = require("./smsBookingNotify.cjs");
      results.sms = await notifyBookingSms(dbQuery, "booking_created", booking, {
        occurrence: "created",
      });
    } catch (e) {
      results.sms = { ok: false, error: e?.message || String(e) };
    }
  } else {
    results.sms = { ok: true, skipped: true, reason: "skip_sms_paid_confirmation" };
  }

  const flags = auraPhase2Flags();
  if (!flags.master) return { ...results, skippedAura: true };

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
  // SMS completed — always attempt (flag-gated inside notify); independent of review followup.
  try {
    const { notifyBookingSms } = require("./smsBookingNotify.cjs");
    void notifyBookingSms(dbQuery, "booking_completed", booking, {
      occurrence: "completed",
    }).catch(() => {});
  } catch {
    /* non-fatal */
  }

  const flags = auraPhase2Flags();
  if (!flags.reviewFollowup || !booking?.id) return { skipped: true };

  let row = booking;
  try {
    const r = await dbQuery(
      `SELECT id, booking_status, customer_name, customer_email, barber_name, service, style_title,
              date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
              total_price, amount, user_id, review_prompt_sent_at
       FROM bookings WHERE id = $1::uuid LIMIT 1`,
      [booking.id],
    );
    if (r.rows?.[0]) row = { ...booking, ...r.rows[0] };
  } catch {
    /* use provided booking */
  }

  const status = String(row.booking_status || "").toLowerCase();
  if (["cancelled", "canceled", "no_show", "noshow"].includes(status)) {
    return { skipped: true, reason: "status_excluded" };
  }
  if (status !== "completed") {
    return { skipped: true, reason: "not_completed" };
  }

  // Idempotent claim — one review follow-up per booking.
  try {
    const claim = await dbQuery(
      `UPDATE bookings
       SET review_prompt_sent_at = COALESCE(review_prompt_sent_at, NOW())
       WHERE id = $1::uuid
         AND review_prompt_sent_at IS NULL
       RETURNING id`,
      [row.id],
    );
    if (!claim.rows?.[0]) {
      return { ok: true, skipped: "already_sent" };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  let rewardsProgress = null;
  try {
    if (row.user_id) {
      const { getLoyaltyDashboard } = await import("./loyaltyService.js");
      const dash = await getLoyaltyDashboard(String(row.user_id));
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
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      barberName: row.barber_name,
      service: row.service || row.style_title,
      date: row.date,
      time: row.time_ampm || row.time,
      price: row.total_price ?? row.amount,
      bookingId: row.id,
      rewardsProgress,
    });
    await logAuraAction(dbQuery, {
      action: "review_followup",
      bookingId: row.id,
      result: out.ok ? "sent" : "failed",
      metadata: { error: out.error || null, to: row.customer_email || null },
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
