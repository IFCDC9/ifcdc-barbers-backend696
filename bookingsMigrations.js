import { dbQuery } from "./db.js";

export async function ensureBookingsTable() {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      customer_name TEXT,
      customer_email TEXT,
      barber_id BIGINT NOT NULL,
      service TEXT NOT NULL,
      date DATE NOT NULL,
      time TIME NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      payment_status TEXT NOT NULL,
      payment_provider TEXT,
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_price NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_type TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS barber_name TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_duration_minutes INT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS services_json JSONB;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS style_id UUID;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS style_title TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS style_image_url TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_paid NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_by TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_prompt_sent_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_from_date DATE;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_from_time TIME;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_to_date DATE;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_to_time TIME;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_by TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2);`);
  // These must run even if client_id FK is deferred (FK add is at end of this file).
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_status TEXT NOT NULL DEFAULT 'confirmed';`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_paid_booking BOOLEAN NOT NULL DEFAULT false;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_id BIGINT;`);

  await dbQuery(`UPDATE bookings SET tip_amount = 0 WHERE tip_amount IS NULL;`);
  await dbQuery(
    `UPDATE bookings SET total_paid = COALESCE(amount_paid, 0) + COALESCE(tip_amount, 0) WHERE total_paid IS NULL;`
  );
  await dbQuery(`UPDATE bookings SET platform_fee = 0 WHERE platform_fee IS NULL;`);
  await dbQuery(`
    UPDATE bookings SET total_amount = round((COALESCE(total_price, amount, 0) + COALESCE(platform_fee, 0))::numeric, 2)
    WHERE total_amount IS NULL;
  `);
  // NEVER blanket-reset is_paid_booking on boot — that wiped paid_in_full rows after every deploy
  // and broke slot blocking / unique constraints. Only backfill missing true flags.
  await dbQuery(`
    UPDATE bookings SET is_paid_booking = true
    WHERE coalesce(is_paid_booking, false) = false
      AND (
        lower(coalesce(payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'deposit_paid', 'captured')
        OR (
          paypal_capture_id IS NOT NULL
          AND coalesce(amount_paid, amount_charged, total_paid, 0) > 0
          AND lower(coalesce(booking_status, '')) IN ('confirmed', 'completed', 'checked_in', 'in_progress')
        )
      );
  `);
  await dbQuery(`
    UPDATE bookings SET payment_status = 'paid_full'
    WHERE payment_status = 'paid' AND COALESCE(remaining_balance, 0) <= 0.01;
  `);
  await dbQuery(`
    UPDATE bookings SET booking_status = 'pending'
    WHERE payment_provider = 'voice'
       OR payment_status = 'pay_in_person';
  `);
  await dbQuery(`
    UPDATE bookings SET
      total_price = COALESCE(total_price, amount),
      deposit_amount = COALESCE(deposit_amount, 0),
      amount_paid = COALESCE(amount_paid, amount),
      remaining_balance = COALESCE(
        remaining_balance,
        GREATEST(0::numeric, COALESCE(total_price, amount) - COALESCE(amount_paid, amount))
      ),
      payment_type = CASE
        WHEN payment_type IS NOT NULL AND btrim(payment_type) <> '' THEN payment_type
        ELSE 'full'
      END
    WHERE total_price IS NULL OR deposit_amount IS NULL OR amount_paid IS NULL OR remaining_balance IS NULL
       OR payment_type IS NULL OR btrim(COALESCE(payment_type, '')) = '';
  `);

  // Idempotency: PayPal IDs must be unique (prevents duplicates on refresh/double-click).
  // Use table UNIQUE constraints (not partial indexes): INSERT ... ON CONFLICT (paypal_capture_id)
  // requires a non-partial unique constraint or matching inference.
  await dbQuery(`DROP INDEX IF EXISTS bookings_paypal_order_unique;`);
  await dbQuery(`DROP INDEX IF EXISTS bookings_paypal_capture_unique;`);
  await dbQuery(`
    DO $m$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_paypal_order_key'
      ) THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_paypal_order_key UNIQUE (paypal_order_id);
      END IF;
    END
    $m$;
  `);
  await dbQuery(`
    DO $m$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_paypal_capture_key'
      ) THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_paypal_capture_key UNIQUE (paypal_capture_id);
      END IF;
    END
    $m$;
  `);

  // Slot uniqueness: confirmed + paid-through-app only — pending / voice do not hold the slot.
  // Include paid_in_full (current settlement status). Recreate index if definition is stale.
  await dbQuery(`DROP INDEX IF EXISTS bookings_slot_unique_paid;`);
  await dbQuery(`DROP INDEX IF EXISTS bookings_slot_unique_confirmed_paid;`);
  await dbQuery(`
    CREATE UNIQUE INDEX bookings_slot_unique_confirmed_paid
    ON bookings (barber_id, date, time)
    WHERE booking_status = 'confirmed'
      AND (
        is_paid_booking = true
        OR lower(coalesce(payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'deposit_paid', 'captured')
      );
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings (created_at DESC);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS bookings_barber_id_idx ON bookings (barber_id);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS bookings_payment_status_idx ON bookings (payment_status);`);

  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_status TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_error_code TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_error_message TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS message_sid TEXT;`);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS bookings_message_sid_idx
    ON bookings (message_sid)
    WHERE message_sid IS NOT NULL AND btrim(message_sid) <> '';
  `);

  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_required BOOLEAN NOT NULL DEFAULT false;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_status VARCHAR(50) NOT NULL DEFAULT 'not_required';`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_payment_link TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_transaction_id TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paypal_order_id TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_price NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_charged NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due NUMERIC(10,2);`);
  await dbQuery(`
    UPDATE bookings SET
      service_price = COALESCE(service_price, total_price, amount),
      balance_due = COALESCE(balance_due, remaining_balance, GREATEST(0::numeric, COALESCE(total_price, amount, 0) - COALESCE(amount_paid, 0))),
      amount_charged = COALESCE(amount_charged, amount_paid, total_paid)
    WHERE service_price IS NULL OR balance_due IS NULL OR amount_charged IS NULL;
  `);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_status VARCHAR(50) NOT NULL DEFAULT 'pending';`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS barber_payout_amount NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS barber_fee_billed BOOLEAN NOT NULL DEFAULT false;`);

  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_by TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delete_reason TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paypal_refund_id TEXT;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2);`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT;`);
  await dbQuery(`
    CREATE INDEX IF NOT EXISTS bookings_deleted_at_idx
    ON bookings (deleted_at)
    WHERE deleted_at IS NOT NULL;
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_fee_ledger (
      id BIGSERIAL PRIMARY KEY,
      barber_id BIGINT NOT NULL,
      booking_id UUID,
      fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0.99,
      fee_status VARCHAR(50) NOT NULL DEFAULT 'accrued',
      billed_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS barber_fee_ledger_barber_id_idx ON barber_fee_ledger (barber_id);`);
  await dbQuery(`
    DO $m$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.barber_fee_ledger'::regclass
          AND conname = 'barber_fee_ledger_booking_id_key'
      ) THEN
        ALTER TABLE barber_fee_ledger
          ADD CONSTRAINT barber_fee_ledger_booking_id_key UNIQUE (booking_id);
      END IF;
    END
    $m$;
  `);
  try {
    await dbQuery(`
      DO $m$
      BEGIN
        IF to_regclass('public.bookings') IS NULL THEN
          RETURN;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.barber_fee_ledger'::regclass
            AND conname = 'barber_fee_ledger_booking_id_fkey'
        ) THEN
          RETURN;
        END IF;
        ALTER TABLE barber_fee_ledger
          ADD CONSTRAINT barber_fee_ledger_booking_id_fkey
          FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
      END $m$;
    `);
  } catch (e) {
    console.warn("[migrate] barber_fee_ledger booking_id FK skipped:", e?.message || e);
  }

  try {
    await dbQuery(`
      DO $m$
      BEGIN
        IF to_regclass('public.barber_clients') IS NULL THEN
          RETURN;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.bookings'::regclass
            AND conname = 'bookings_client_id_fkey'
        ) THEN
          RETURN;
        END IF;
        ALTER TABLE bookings
          ADD CONSTRAINT bookings_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES barber_clients(id) ON DELETE SET NULL;
      END $m$;
    `);
  } catch (e) {
    console.warn("[migrate] bookings client_id FK skipped:", e?.message || e);
  }
}

