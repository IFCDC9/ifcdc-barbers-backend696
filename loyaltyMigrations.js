import { dbQuery } from "./db.js";

export async function ensureLoyaltySchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_transactions_user_idx ON loyalty_transactions (user_id, created_at DESC);`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_booking_earn_uidx
     ON loyalty_transactions (booking_id)
     WHERE booking_id IS NOT NULL AND delta > 0;`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_rewards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      barber_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      points_cost INTEGER NOT NULL CHECK (points_cost > 0),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_rewards_barber_idx ON loyalty_rewards (barber_id, is_active);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS loyalty_redemptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      reward_id UUID NOT NULL REFERENCES loyalty_rewards(id) ON DELETE RESTRICT,
      points_spent INTEGER NOT NULL CHECK (points_spent > 0),
      status TEXT NOT NULL DEFAULT 'redeemed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS loyalty_redemptions_user_idx ON loyalty_redemptions (user_id, created_at DESC);`,
  );
}
