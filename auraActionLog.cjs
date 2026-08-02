/**
 * AURA Phase 2 action audit log (additive, safe when DB unavailable).
 */
async function ensureAuraActionLogTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_action_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor TEXT,
      user_id UUID,
      action TEXT NOT NULL,
      booking_id UUID,
      result TEXT,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_action_logs_created_idx ON aura_action_logs (created_at DESC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_action_logs_action_idx ON aura_action_logs (action)`,
  );
}

async function ensureAuraReminderColumns(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_2h_sent_at TIMESTAMPTZ`);
  await dbQuery(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`);
}

async function logAuraAction(dbQuery, {
  actor = "aura",
  userId = null,
  action,
  bookingId = null,
  result = "ok",
  metadata = null,
} = {}) {
  const act = String(action || "").trim().slice(0, 120);
  if (!act || typeof dbQuery !== "function") return { ok: false, skipped: true };
  try {
    await ensureAuraActionLogTable(dbQuery);
    await dbQuery(
      `INSERT INTO aura_action_logs (actor, user_id, action, booking_id, result, metadata)
       VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6::jsonb)`,
      [
        String(actor || "aura").slice(0, 120),
        userId || null,
        act,
        bookingId || null,
        String(result || "ok").slice(0, 80),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    return { ok: true };
  } catch (e) {
    console.warn("[aura-log] write failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  ensureAuraActionLogTable,
  ensureAuraReminderColumns,
  logAuraAction,
};
