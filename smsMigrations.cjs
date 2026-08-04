/**
 * SMS schema — delivery log, consent, phone verification columns.
 * Additive only; safe when SMS flags are off.
 */
async function ensureSmsMessageLogTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS sms_message_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      twilio_sid TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      to_e164 TEXT,
      from_identity TEXT,
      category TEXT NOT NULL,
      booking_id UUID,
      payment_ref TEXT,
      user_id UUID,
      body_preview TEXT,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT,
      provider_payload JSONB,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_message_log_created_idx ON sms_message_log (created_at DESC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_message_log_sid_idx ON sms_message_log (twilio_sid)
     WHERE twilio_sid IS NOT NULL`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_message_log_booking_idx ON sms_message_log (booking_id)
     WHERE booking_id IS NOT NULL`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_message_log_category_idx ON sms_message_log (category, created_at DESC)`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS sms_message_log_idempotency_uidx
     ON sms_message_log (idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  );
}

async function ensureSmsConsentTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS sms_consent (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id UUID,
      phone_e164 TEXT NOT NULL,
      transactional_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
      opted_out_at TIMESTAMPTZ,
      opted_in_at TIMESTAMPTZ,
      last_inbound_keyword TEXT,
      source TEXT,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS sms_consent_phone_uidx ON sms_consent (phone_e164)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_consent_user_idx ON sms_consent (user_id)
     WHERE user_id IS NOT NULL`,
  );
}

async function ensureSmsVerifyRateLimitTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS sms_verify_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      phone_e164 TEXT NOT NULL,
      purpose TEXT NOT NULL,
      actor_user_id UUID,
      ip_text TEXT,
      action TEXT NOT NULL,
      result TEXT,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS sms_verify_attempts_phone_created_idx
     ON sms_verify_attempts (phone_e164, created_at DESC)`,
  );
}

async function ensureAppUserPhoneVerificationColumns(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_e164 TEXT`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false`);
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS app_users_phone_e164_idx ON app_users (phone_e164)
     WHERE phone_e164 IS NOT NULL`,
  );
}

async function ensureSmsPreferenceColumns(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(
    `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_booking_confirmations BOOLEAN DEFAULT TRUE`,
  );
  await dbQuery(
    `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_reminders BOOLEAN DEFAULT TRUE`,
  );
  await dbQuery(
    `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_cancellations BOOLEAN DEFAULT TRUE`,
  );
  await dbQuery(
    `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_payment_updates BOOLEAN DEFAULT TRUE`,
  );
  await dbQuery(
    `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN DEFAULT TRUE`,
  );
}

async function ensureSmsSchema(dbQuery) {
  await ensureSmsMessageLogTable(dbQuery);
  await ensureSmsConsentTable(dbQuery);
  await ensureSmsVerifyRateLimitTable(dbQuery);
  await ensureAppUserPhoneVerificationColumns(dbQuery);
  await ensureSmsPreferenceColumns(dbQuery);
}

module.exports = {
  ensureSmsMessageLogTable,
  ensureSmsConsentTable,
  ensureSmsVerifyRateLimitTable,
  ensureAppUserPhoneVerificationColumns,
  ensureSmsPreferenceColumns,
  ensureSmsSchema,
};
