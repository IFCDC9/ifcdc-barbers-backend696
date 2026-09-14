import db from "../db/db.js"

let ensured = false

export async function ensureSubscriptionSchema() {
  if (ensured) return
  ensured = true
  await db.query(`
    CREATE TABLE IF NOT EXISTS barber_subscriptions (
      barber_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'trial',
      trial_started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      trial_ends_at TIMESTAMP,
      current_period_end TIMESTAMP,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)
}

export function computeActive({ status, trial_ends_at, current_period_end } = {}) {
  const now = Date.now()
  const st = String(status || "").toLowerCase()
  const trialEnds = trial_ends_at ? new Date(trial_ends_at).getTime() : 0
  const periodEnd = current_period_end ? new Date(current_period_end).getTime() : 0

  if (st === "trial") return trialEnds > now
  if (st === "active") return periodEnd > now
  return false
}

export async function getSubscription(barberId) {
  await ensureSubscriptionSchema()
  const id = Number(barberId)
  if (!Number.isFinite(id) || id <= 0) return null
  const r = await db.query(`SELECT * FROM barber_subscriptions WHERE barber_id = $1 LIMIT 1`, [id])
  return r.rows[0] || null
}

export async function startTrial(barberId, days = 7) {
  const { assertLegacyWriteNotUsed } = await import("../../legacySubscriptionFreeze.js")
  assertLegacyWriteNotUsed("sevenDayStartTrial")
  await ensureSubscriptionSchema()
  const id = Number(barberId)
  if (!Number.isFinite(id) || id <= 0) throw new Error("invalid_barber_id")
  const d = Number(days)
  const safeDays = Number.isFinite(d) && d > 0 ? Math.floor(d) : 7
  const r = await db.query(
    `
      INSERT INTO barber_subscriptions (barber_id, status, trial_started_at, trial_ends_at, updated_at)
      VALUES ($1, 'trial', NOW(), NOW() + ($2 || ' days')::interval, NOW())
      ON CONFLICT (barber_id)
      DO UPDATE SET
        status = 'trial',
        trial_started_at = NOW(),
        trial_ends_at = NOW() + ($2 || ' days')::interval,
        current_period_end = NULL,
        cancel_at_period_end = FALSE,
        updated_at = NOW()
      RETURNING *
    `,
    [id, String(safeDays)]
  )
  return r.rows[0]
}

export async function activateMonthly(barberId, months = 1) {
  const { assertLegacyWriteNotUsed } = await import("../../legacySubscriptionFreeze.js")
  assertLegacyWriteNotUsed("activateMonthly")
  await ensureSubscriptionSchema()
  const id = Number(barberId)
  if (!Number.isFinite(id) || id <= 0) throw new Error("invalid_barber_id")
  const m = Number(months)
  const safeMonths = Number.isFinite(m) && m > 0 ? Math.floor(m) : 1
  const r = await db.query(
    `
      INSERT INTO barber_subscriptions (barber_id, status, current_period_end, updated_at)
      VALUES ($1, 'active', NOW() + ($2 || ' months')::interval, NOW())
      ON CONFLICT (barber_id)
      DO UPDATE SET
        status = 'active',
        current_period_end = GREATEST(COALESCE(barber_subscriptions.current_period_end, NOW()), NOW()) + ($2 || ' months')::interval,
        cancel_at_period_end = FALSE,
        updated_at = NOW()
      RETURNING *
    `,
    [id, String(safeMonths)]
  )
  return r.rows[0]
}

export async function listSubscriptions({ activeOnly = false } = {}) {
  await ensureSubscriptionSchema()
  const r = await db.query(`
    SELECT barber_id, status, trial_started_at, trial_ends_at, current_period_end, cancel_at_period_end, updated_at
    FROM barber_subscriptions
    ORDER BY barber_id ASC
  `)
  const rows = r.rows || []
  if (!activeOnly) return rows
  return rows.filter((row) => computeActive(row))
}

export async function isBarberSubscribed(barberId) {
  const sub = await getSubscription(barberId)
  if (!sub) return false
  return computeActive(sub)
}

