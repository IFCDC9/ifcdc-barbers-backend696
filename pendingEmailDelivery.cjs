/**
 * Pending email delivery queue — preserves failed outbound emails for retry
 * when the provider (Resend) is unavailable. Does not change Resend config
 * or payment settlement. Payment remains saved independently of email.
 */
const KIND_BOOKING_CONFIRMATION = "booking_confirmation";
const KIND_PAYMENT_CONFIRMATION = "payment_confirmation";
const KIND_ADMIN_NOTIFICATION = "admin_notification";
const STATUS_PENDING = "pending_delivery";
const STATUS_SENT = "sent";
const STATUS_CANCELLED = "cancelled";

/** Only non-security transactional mail may be queued. Login/OTP codes must never be queued. */
const ALLOWED_PENDING_KINDS = new Set([
  KIND_BOOKING_CONFIRMATION,
  KIND_PAYMENT_CONFIRMATION,
  KIND_ADMIN_NOTIFICATION,
]);

const FORBIDDEN_PENDING_KIND_RE =
  /(otp|login.?code|verif(?:ication)?.?code|auth.?code|magic.?link|password.?reset)/i;

function assertQueueableEmailKind(kind) {
  const k = String(kind || "").trim();
  if (!k) return { ok: false, error: "kind_required" };
  if (FORBIDDEN_PENDING_KIND_RE.test(k) || /otp|login|auth_challenge/i.test(k)) {
    return { ok: false, error: "security_sensitive_email_not_queueable", kind: k };
  }
  if (!ALLOWED_PENDING_KINDS.has(k)) {
    return { ok: false, error: "kind_not_allowed", kind: k };
  }
  return { ok: true, kind: k };
}

async function ensurePendingEmailDeliveryTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS pending_email_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_delivery',
      booking_id UUID,
      to_email TEXT,
      capture_id TEXT,
      paypal_order_id TEXT,
      last_error TEXT,
      attempts INT NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS pending_email_deliveries_status_idx
     ON pending_email_deliveries (status, created_at ASC)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS pending_email_deliveries_booking_idx
     ON pending_email_deliveries (booking_id)`,
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS pending_email_deliveries_kind_booking_pending_uidx
     ON pending_email_deliveries (kind, booking_id)
     WHERE status = 'pending_delivery' AND booking_id IS NOT NULL`,
  );
}

/**
 * Upsert a pending delivery row for a booking confirmation that failed to send.
 * Idempotent for the same booking while status is pending_delivery.
 */
async function enqueuePendingEmailDelivery(
  dbQuery,
  {
    kind = KIND_BOOKING_CONFIRMATION,
    bookingId = null,
    toEmail = null,
    captureId = null,
    paypalOrderId = null,
    lastError = null,
    metadata = null,
  } = {},
) {
  if (typeof dbQuery !== "function") return { ok: false, skipped: true };
  const kindCheck = assertQueueableEmailKind(kind);
  if (!kindCheck.ok) {
    console.warn("[pending-email] refused enqueue:", kindCheck.error, kindCheck.kind || kind);
    return { ok: false, error: kindCheck.error };
  }
  const k = kindCheck.kind;
  try {
    await ensurePendingEmailDeliveryTable(dbQuery);
    if (bookingId) {
      const existing = await dbQuery(
        `SELECT id, attempts FROM pending_email_deliveries
         WHERE kind = $1 AND booking_id = $2::uuid AND status = $3
         LIMIT 1`,
        [k, bookingId, STATUS_PENDING],
      );
      if (existing.rows?.[0]) {
        const id = existing.rows[0].id;
        await dbQuery(
          `UPDATE pending_email_deliveries
           SET updated_at = NOW(),
               to_email = COALESCE($2, to_email),
               capture_id = COALESCE($3, capture_id),
               paypal_order_id = COALESCE($4, paypal_order_id),
               last_error = COALESCE($5, last_error),
               attempts = attempts + 1,
               metadata = COALESCE($6::jsonb, metadata)
           WHERE id = $1::uuid`,
          [
            id,
            toEmail || null,
            captureId || null,
            paypalOrderId || null,
            lastError ? String(lastError).slice(0, 2000) : null,
            metadata ? JSON.stringify(metadata) : null,
          ],
        );
        return { ok: true, id, status: STATUS_PENDING, updated: true };
      }
    }
    const inserted = await dbQuery(
      `INSERT INTO pending_email_deliveries
         (kind, status, booking_id, to_email, capture_id, paypal_order_id, last_error, attempts, metadata)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 1, $8::jsonb)
       RETURNING id`,
      [
        k,
        STATUS_PENDING,
        bookingId || null,
        toEmail || null,
        captureId || null,
        paypalOrderId || null,
        lastError ? String(lastError).slice(0, 2000) : null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    return {
      ok: true,
      id: inserted.rows?.[0]?.id || null,
      status: STATUS_PENDING,
      created: true,
    };
  } catch (e) {
    console.warn("[pending-email] enqueue failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function listPendingEmailDeliveries(dbQuery, { kind = null, limit = 50 } = {}) {
  if (typeof dbQuery !== "function") return [];
  await ensurePendingEmailDeliveryTable(dbQuery);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  if (kind) {
    const r = await dbQuery(
      `SELECT * FROM pending_email_deliveries
       WHERE status = $1 AND kind = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      [STATUS_PENDING, String(kind), lim],
    );
    return r.rows || [];
  }
  const r = await dbQuery(
    `SELECT * FROM pending_email_deliveries
     WHERE status = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [STATUS_PENDING, lim],
  );
  return r.rows || [];
}

async function markPendingEmailSent(dbQuery, { id = null, bookingId = null, kind = KIND_BOOKING_CONFIRMATION, messageId = null } = {}) {
  if (typeof dbQuery !== "function") return { ok: false, skipped: true };
  await ensurePendingEmailDeliveryTable(dbQuery);
  if (id) {
    await dbQuery(
      `UPDATE pending_email_deliveries
       SET status = $2, sent_at = NOW(), updated_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $1::uuid AND status = $4`,
      [id, STATUS_SENT, JSON.stringify({ messageId: messageId || null }), STATUS_PENDING],
    );
    return { ok: true };
  }
  if (bookingId) {
    await dbQuery(
      `UPDATE pending_email_deliveries
       SET status = $3, sent_at = NOW(), updated_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
       WHERE booking_id = $1::uuid AND kind = $2 AND status = $5`,
      [
        bookingId,
        String(kind || KIND_BOOKING_CONFIRMATION),
        STATUS_SENT,
        JSON.stringify({ messageId: messageId || null }),
        STATUS_PENDING,
      ],
    );
    return { ok: true };
  }
  return { ok: false, error: "id_or_booking_required" };
}

module.exports = {
  KIND_BOOKING_CONFIRMATION,
  KIND_PAYMENT_CONFIRMATION,
  KIND_ADMIN_NOTIFICATION,
  STATUS_PENDING,
  STATUS_SENT,
  STATUS_CANCELLED,
  ALLOWED_PENDING_KINDS,
  assertQueueableEmailKind,
  ensurePendingEmailDeliveryTable,
  enqueuePendingEmailDelivery,
  listPendingEmailDeliveries,
  markPendingEmailSent,
};
