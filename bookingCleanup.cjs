/**
 * Release schedule slots held by abandoned checkout sessions.
 * Default hold matches barberSlotEngine PENDING_HOLD_MINUTES (15).
 */
const PENDING_HOLD_MINUTES = Number(process.env.BOOKING_PENDING_HOLD_MINUTES || 15);

async function expireStalePendingPaymentBookings(dbQuery) {
  const hold = Math.max(1, Number(PENDING_HOLD_MINUTES) || 15);
  try {
    const r = await dbQuery(
      `UPDATE bookings
       SET booking_status = 'cancelled',
           is_paid_booking = false,
           cancelled_at = COALESCE(cancelled_at, NOW()),
           cancelled_by = COALESCE(cancelled_by, 'system'),
           cancellation_reason = COALESCE(
             NULLIF(trim(cancellation_reason), ''),
             'Checkout expired — slot released automatically'
           )
       WHERE deleted_at IS NULL
         AND lower(coalesce(booking_status, '')) IN ('pending', 'pending_payment')
         AND coalesce(is_paid_booking, false) = false
         AND lower(coalesce(payment_status, '')) NOT IN (
           'paid', 'paid_full', 'paid_in_full', 'deposit_paid', 'captured'
         )
         AND created_at < NOW() - ($1::text || ' minutes')::interval
       RETURNING id`,
      [String(hold)],
    );
    const count = r.rows?.length || 0;
    if (count > 0) {
      console.log("[booking-cleanup] released", count, "stale pending checkout slot(s)");
    }
    return count;
  } catch (e) {
    console.warn("[booking-cleanup] expire stale pending failed:", e?.message || e);
    return 0;
  }
}

module.exports = { expireStalePendingPaymentBookings };
