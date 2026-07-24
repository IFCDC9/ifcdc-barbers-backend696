/**
 * Schema for Super Admin Manual Booking (Bypass Mode).
 */
export async function ensureManualBypassBookingColumns(dbQuery) {
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS manual_bypass BOOLEAN DEFAULT false`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bypass_payment_type TEXT`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bypass_reason TEXT`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bypass_created_by UUID`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bypass_created_by_email TEXT`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bypass_created_at TIMESTAMPTZ`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_notes TEXT`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_source TEXT`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS bookings_manual_bypass_idx ON bookings (manual_bypass) WHERE manual_bypass = true`,
  ).catch(() => {});
}
