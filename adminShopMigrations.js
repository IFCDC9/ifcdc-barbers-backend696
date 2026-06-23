import { dbQuery } from "./db.js";

let ready = false;

/** Schema for global shop management and Super Admin control center. */
export async function ensureAdminShopManagementSchema() {
  if (ready) return;

  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active';`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'approved';`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS access_plan TEXT DEFAULT 'free';`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS free_access_enabled BOOLEAN DEFAULT true;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paid_subscription_required BOOLEAN DEFAULT false;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS bookings_enabled BOOLEAN DEFAULT true;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_processing_enabled BOOLEAN DEFAULT true;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(10,2) DEFAULT 0;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approved_by UUID;`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`);

  await dbQuery(
    `UPDATE businesses SET account_status = 'active' WHERE account_status IS NULL OR btrim(account_status) = '';`,
  );
  await dbQuery(
    `UPDATE businesses SET approval_status = 'approved' WHERE approval_status IS NULL OR btrim(approval_status) = '';`,
  );
  await dbQuery(
    `UPDATE businesses SET access_plan = CASE
       WHEN lower(coalesce(plan, 'free')) IN ('pro', 'elite', 'paid') THEN 'paid'
       WHEN lower(coalesce(subscription_status, '')) = 'trial' THEN 'trial'
       ELSE coalesce(access_plan, 'free')
     END
     WHERE access_plan IS NULL OR btrim(access_plan) = '';`,
  );
  await dbQuery(`UPDATE businesses SET bookings_enabled = true WHERE bookings_enabled IS NULL;`);
  await dbQuery(`UPDATE businesses SET payment_processing_enabled = true WHERE payment_processing_enabled IS NULL;`);
  await dbQuery(`UPDATE businesses SET free_access_enabled = true WHERE free_access_enabled IS NULL;`);

  ready = true;
}

/** Defaults for newly registered shops (pending Super Admin approval). */
export const NEW_SHOP_PENDING_DEFAULTS = {
  plan: "free",
  subscription_status: "inactive",
  account_status: "pending",
  approval_status: "pending",
  access_plan: "pending",
  free_access_enabled: false,
  paid_subscription_required: true,
  bookings_enabled: false,
  payment_processing_enabled: false,
};
