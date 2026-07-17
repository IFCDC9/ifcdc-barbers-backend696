import { dbQuery } from "./db.js";

export async function ensureLoyaltySchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
      lifetime_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_redeemed >= 0),
      completed_haircuts INTEGER NOT NULL DEFAULT 0 CHECK (completed_haircuts >= 0),
      points_debt INTEGER NOT NULL DEFAULT 0 CHECK (points_debt >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS lifetime_redeemed INTEGER NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS completed_haircuts INTEGER NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS points_debt INTEGER NOT NULL DEFAULT 0;`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
      redemption_id UUID,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      transaction_type TEXT NOT NULL DEFAULT 'adjustment',
      idempotency_key TEXT,
      created_by TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS redemption_id UUID;`);
  await dbQuery(`ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS transaction_type TEXT NOT NULL DEFAULT 'adjustment';`);
  await dbQuery(`ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;`);
  await dbQuery(`ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS created_by TEXT;`);
  await dbQuery(`ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await dbQuery(`
    UPDATE loyalty_transactions
    SET transaction_type = 'earn',
        idempotency_key = COALESCE(idempotency_key, 'earn:booking:' || booking_id::text)
    WHERE booking_id IS NOT NULL
      AND delta > 0
      AND reason = 'booking_completed'
      AND transaction_type = 'adjustment';
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_transactions_user_idx ON loyalty_transactions (user_id, created_at DESC);`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_idempotency_uidx
     ON loyalty_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;`,
  );
  // Replace the legacy `delta > 0` predicate; restored points are positive too.
  await dbQuery(`DROP INDEX IF EXISTS loyalty_transactions_booking_earn_uidx;`);
  await dbQuery(
    `CREATE UNIQUE INDEX loyalty_transactions_booking_earn_uidx
     ON loyalty_transactions (booking_id)
     WHERE booking_id IS NOT NULL AND transaction_type = 'earn';`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_rewards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      barber_id TEXT,
      business_id BIGINT,
      reward_key TEXT,
      title TEXT NOT NULL,
      description TEXT,
      points_cost INTEGER NOT NULL CHECK (points_cost > 0),
      reward_type TEXT NOT NULL DEFAULT 'custom',
      reward_value NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (reward_value >= 0),
      eligible_services JSONB NOT NULL DEFAULT '[]'::jsonb,
      eligible_barbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      expires_at TIMESTAMPTZ,
      quantity_limit INTEGER CHECK (quantity_limit IS NULL OR quantity_limit > 0),
      quantity_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (quantity_redeemed >= 0),
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_deleted BOOLEAN NOT NULL DEFAULT false,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS business_id BIGINT;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS reward_key TEXT;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS reward_type TEXT NOT NULL DEFAULT 'custom';`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS reward_value NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS eligible_services JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS eligible_barbers JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS quantity_limit INTEGER;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS quantity_redeemed INTEGER NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS created_by TEXT;`);
  await dbQuery(`ALTER TABLE loyalty_rewards ADD COLUMN IF NOT EXISTS updated_by TEXT;`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_rewards_barber_idx ON loyalty_rewards (barber_id, is_active);`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_rewards_business_idx ON loyalty_rewards (business_id, is_active);`,
  );
  await dbQuery(`DROP INDEX IF EXISTS loyalty_rewards_key_uidx;`);
  await dbQuery(
    `CREATE UNIQUE INDEX loyalty_rewards_key_uidx
     ON loyalty_rewards (reward_key) WHERE reward_key IS NOT NULL;`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS loyalty_rewards_promo_code_uidx
     ON loyalty_rewards (UPPER(metadata->>'promoCode'))
     WHERE COALESCE(metadata->>'promoCode', '') <> '' AND is_deleted = false;`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_redemptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      reward_id UUID NOT NULL REFERENCES loyalty_rewards(id) ON DELETE RESTRICT,
      booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
      points_spent INTEGER NOT NULL CHECK (points_spent > 0),
      discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      status TEXT NOT NULL DEFAULT 'reserved',
      reserved_at TIMESTAMPTZ,
      redeemed_at TIMESTAMPTZ,
      restored_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await dbQuery(`ALTER TABLE loyalty_redemptions ALTER COLUMN status SET DEFAULT 'reserved';`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_redemptions_user_idx ON loyalty_redemptions (user_id, created_at DESC);`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS loyalty_redemptions_booking_uidx
     ON loyalty_redemptions (booking_id) WHERE booking_id IS NOT NULL AND status IN ('reserved', 'redeemed');`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      actor_label TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_data JSONB,
      after_data JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_audit_logs_created_idx ON loyalty_audit_logs (created_at DESC);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_program_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id BIGINT,
      barber_id TEXT,
      points_per_completed_booking INTEGER NOT NULL DEFAULT 5 CHECK (points_per_completed_booking > 0),
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id BIGINT,
      barber_id TEXT,
      name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      points_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (points_multiplier >= 0),
      bonus_points INTEGER NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_campaigns_active_idx
     ON loyalty_campaigns (event_type, starts_at, ends_at) WHERE is_active = true;`,
  );

  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS loyalty_redemption_id UUID;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reward_discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reward_title TEXT;`);

  await dbQuery(`
    UPDATE loyalty_accounts a
    SET completed_haircuts = earned.completed_count
    FROM (
      SELECT user_id, COUNT(DISTINCT booking_id)::int AS completed_count
      FROM loyalty_transactions
      WHERE transaction_type = 'earn' AND booking_id IS NOT NULL
      GROUP BY user_id
    ) earned
    WHERE earned.user_id = a.user_id
      AND a.completed_haircuts = 0;
  `);
}
