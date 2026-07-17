/**
 * Idempotent booking completion + first-time review prompt side effects.
 */
async function ensureCompletionColumns(dbQuery) {
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_by TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_prompt_sent_at TIMESTAMPTZ;`);
}

/**
 * Mark booking completed once. Returns { alreadyCompleted, booking } or null if not found.
 */
async function markBookingCompletedIdempotent(dbQuery, {
  bookingId,
  actorLabel = "system",
  tenantSql = "",
  scopeParams = null,
} = {}) {
  const id = String(bookingId || "").trim();
  if (!id) return null;

  await ensureCompletionColumns(dbQuery).catch(() => {});

  const params = scopeParams && Array.isArray(scopeParams) ? scopeParams : [id];
  const idParam = "$1";
  // First-completion only — skip side effects if already completed.
  const r = await dbQuery(
    `UPDATE bookings
     SET booking_status = 'completed',
         completed_at = COALESCE(completed_at, NOW()),
         completed_by = COALESCE(completed_by, $${params.length + 1})
     WHERE id = ${idParam}::uuid
       ${tenantSql}
       AND lower(coalesce(booking_status, '')) <> 'completed'
     RETURNING id, booking_status, payment_status, completed_at, completed_by,
               barber_id, barber_name, user_id, customer_email, customer_name,
               service, style_id, business_id, client_id, is_paid_booking,
               total_price, total_amount, amount_paid, total_paid, refunded_at,
               services_json, service_price, loyalty_redemption_id`,
    [...params, String(actorLabel || "system")],
  );

  if (r.rows?.[0]) {
    return { alreadyCompleted: false, booking: r.rows[0], firstCompletion: true };
  }

  const existing = await dbQuery(
    `SELECT id, booking_status, payment_status, completed_at, completed_by,
            barber_id, barber_name, user_id, customer_email, customer_name,
            service, style_id, business_id, client_id, is_paid_booking,
            total_price, total_amount, amount_paid, total_paid, refunded_at,
            services_json, service_price, loyalty_redemption_id
     FROM bookings
     WHERE id = $1::uuid ${tenantSql}
     LIMIT 1`,
    params,
  );
  if (!existing.rows?.[0]) return null;
  return {
    alreadyCompleted: String(existing.rows[0].booking_status || "").toLowerCase() === "completed",
    booking: existing.rows[0],
    firstCompletion: false,
  };
}

async function runCompletionSideEffects({
  booking,
  firstCompletion,
  recordStatusChange,
  previousStatus,
  actor,
  note,
  dispatchBookingPush,
}) {
  if (!booking?.id) return { reviewPrompt: false };

  if (firstCompletion && typeof recordStatusChange === "function") {
    await recordStatusChange({
      bookingId: String(booking.id),
      previousStatus: previousStatus || "confirmed",
      newStatus: "completed",
      actor,
      note: note || null,
    }).catch(() => {});
  }

  if (!firstCompletion) {
    let loyalty = null;
    try {
      const loyaltyService = await import("./loyaltyService.js");
      loyalty = await loyaltyService.earnLoyaltyForCompletedBooking({ ...booking, id: booking.id });
    } catch (error) {
      console.warn("[loyalty] completion retry award:", error?.message || error);
    }
    return { reviewPrompt: false, skipped: "already_completed", loyalty };
  }

  void import("./socialPortfolioService.js")
    .then((m) =>
      m.scheduleHaircutFollowupReminder({
        id: booking.id,
        barber_id: booking.barber_id,
        user_id: booking.user_id,
        customer_email: booking.customer_email,
        booking_status: "completed",
      }),
    )
    .catch(() => {});

  void import("./socialPortfolioService.js")
    .then((m) =>
      m.notifyCustomerReviewPrompt({
        id: booking.id,
        barber_id: booking.barber_id,
        barber_name: booking.barber_name,
        user_id: booking.user_id,
        customer_email: booking.customer_email,
        customer_name: booking.customer_name,
        booking_status: "completed",
      }),
    )
    .catch(() => {});

  let loyalty = null;
  try {
    const loyaltyService = await import("./loyaltyService.js");
    loyalty = await loyaltyService.earnLoyaltyForCompletedBooking({ ...booking, id: booking.id });
  } catch (error) {
    console.warn("[loyalty] completion award:", error?.message || error);
  }

  if (typeof dispatchBookingPush === "function") {
    void dispatchBookingPush({
      booking,
      kind: "booking_status_update",
      audience: ["customer", "barber", "shop_owners"],
      data: { bookingId: String(booking.id), status: "completed", type: "leave_review" },
    });
  }

  return { reviewPrompt: true, loyalty };
}

module.exports = {
  ensureCompletionColumns,
  markBookingCompletedIdempotent,
  runCompletionSideEffects,
};
