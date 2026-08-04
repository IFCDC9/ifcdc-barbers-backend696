import { dbQuery } from "./db.js";

let pushReady = false;
let prefsReady = false;

/**
 * Stores Expo push tokens registered by the mobile app on a per-user basis.
 * Multiple tokens per user are allowed (one per device) but the (user_id, expo_token)
 * pair is unique so re-registers from the same device update in place.
 *
 * `business_id` and `barber_id` are denormalized snapshots of the user's tenant
 * scope at registration time so dispatch can fan out without joining app_users
 * on the hot path.
 */
export async function ensurePushTokensTable() {
  if (pushReady) return;
  try {
    await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        expo_token TEXT NOT NULL,
        platform TEXT,
        device_name TEXT,
        app_version TEXT,
        role TEXT,
        business_id BIGINT,
        barber_id TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbQuery(
      `CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_token_uq ON push_tokens (user_id, expo_token);`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id) WHERE is_active = true;`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS push_tokens_business_idx ON push_tokens (business_id) WHERE is_active = true;`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS push_tokens_barber_idx ON push_tokens (barber_id) WHERE is_active = true;`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS push_tokens_role_idx ON push_tokens (role) WHERE is_active = true;`,
    );
    pushReady = true;
  } catch (e) {
    console.warn("[migrate] ensurePushTokensTable:", e?.message || e);
  }
}

/**
 * Per-user notification preferences. Marketing is OFF by default per spec;
 * everything else is ON by default so existing customers don't lose alerts on
 * upgrade. Mirrored on the client side (mobile/services/notificationPrefs.ts).
 */
export async function ensureNotificationPreferencesTable() {
  if (prefsReady) return;
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id UUID PRIMARY KEY,
        push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        booking_confirmations BOOLEAN NOT NULL DEFAULT TRUE,
        reminders BOOLEAN NOT NULL DEFAULT TRUE,
        cancellations BOOLEAN NOT NULL DEFAULT TRUE,
        reschedules BOOLEAN NOT NULL DEFAULT TRUE,
        status_updates BOOLEAN NOT NULL DEFAULT TRUE,
        admin_alerts BOOLEAN NOT NULL DEFAULT TRUE,
        marketing BOOLEAN NOT NULL DEFAULT FALSE,
        email_booking_confirmations BOOLEAN NOT NULL DEFAULT TRUE,
        email_reminders BOOLEAN NOT NULL DEFAULT TRUE,
        sms_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
        sms_booking_confirmations BOOLEAN NOT NULL DEFAULT TRUE,
        sms_reminders BOOLEAN NOT NULL DEFAULT TRUE,
        sms_cancellations BOOLEAN NOT NULL DEFAULT TRUE,
        sms_payment_updates BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Additive columns for older DBs that already had the table.
    await dbQuery(
      `ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN DEFAULT TRUE`,
    );
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
    prefsReady = true;
  } catch (e) {
    console.warn("[migrate] ensureNotificationPreferencesTable:", e?.message || e);
  }
}

/**
 * Best-effort one-shot bootstrap called from server.js.
 */
export async function ensurePushNotificationsSchema() {
  await ensurePushTokensTable();
  await ensureNotificationPreferencesTable();
}
