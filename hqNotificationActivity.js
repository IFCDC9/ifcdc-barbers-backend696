/**
 * Read-only notification activity for IFCDC Headquarters.
 * SELECT from email_delivery_claims and sms_message_log only.
 * The HQ read token cannot insert, update, retry, acknowledge, or send.
 */
import express from "express";
import { requireHqSnapshotRead } from "./hqOperationsSnapshot.js";

const ROW_LIMIT = 50;

export const EMAIL_CLAIM_COLUMNS = [
  "idempotency_key",
  "template_id",
  "status",
  "provider",
  "message_id",
  "updated_at",
  "created_at",
  "retry_count",
  "fallback_used",
  "error",
  "error_reason",
  "recipient",
  "booking_id",
];

export const SMS_LOG_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "twilio_sid",
  "status",
  "to_e164",
  "category",
  "booking_id",
  "user_id",
  "error_code",
  "error_message",
  "idempotency_key",
  "metadata",
  "provider",
  "retry_count",
  "fallback_used",
];

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error("unsafe_identifier");
  }
  return `"${name}"`;
}

export function selectStoredColumns(wanted, present) {
  const available = present instanceof Set ? present : new Set(present || []);
  return wanted.filter((name) => available.has(name) && /^[a-z_][a-z0-9_]*$/.test(name));
}

export function readOnlySelect(table, columns) {
  const selected = selectStoredColumns(
    table === "sms_message_log" ? SMS_LOG_COLUMNS : EMAIL_CLAIM_COLUMNS,
    columns,
  );
  if (!selected.length) return null;
  const order = selected.includes("updated_at")
    ? "updated_at"
    : selected.includes("created_at")
      ? "created_at"
      : null;
  const orderSql = order ? ` ORDER BY ${quoteIdent(order)} DESC NULLS LAST` : "";
  return `SELECT ${selected.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}${orderSql} LIMIT ${ROW_LIMIT}`;
}

function timeValue(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return String(value);
}

function textOrNull(value) {
  if (value == null || value === "") return null;
  return String(value);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  if (value == null || value === "") return null;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "t" || text === "1") return true;
  if (text === "false" || text === "f" || text === "0") return false;
  return null;
}

export function storedDeliveryStatus(status) {
  const stored = String(status || "").trim().toLowerCase();
  if (!stored) return null;
  if (stored === "sent") return "accepted";
  if (stored === "failed") return "failed";
  if (stored === "delivered") return "delivered";
  if (stored === "bounced" || stored === "bounce") return "bounced";
  if (
    stored === "in_flight" ||
    stored === "uncertain" ||
    stored === "queued" ||
    stored === "sending" ||
    stored === "pending" ||
    stored === "skipped_flag_off" ||
    stored === "skipped_consent"
  ) {
    return "pending";
  }
  return stored;
}

function bookingIdFromKey(key) {
  const match = String(key || "").match(/^booking:([^:]+):/);
  return match ? match[1] : null;
}

function relationshipFromTemplate(template) {
  const name = String(template || "");
  if (name === "admin_notice") return "shop_admin";
  if (name === "booking_confirmation" || name === "booking_reschedule" || name === "booking_cancellation") {
    return "customer";
  }
  return null;
}

function reminderWindowFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata.reminderWindow ?? metadata.occurrence ?? metadata.window ?? null;
  if (value == null || value === "") return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function relationshipFromSms(row) {
  const category = String(row.category || "");
  if (
    category === "booking_approved" ||
    category === "booking_created" ||
    category === "booking_rescheduled" ||
    category === "booking_canceled" ||
    category === "booking_reminder"
  ) {
    return "customer";
  }
  if (category.includes("barber")) return "barber";
  if (category.includes("admin") || category.includes("shop")) return "shop_admin";
  return null;
}

export function mapEmailClaim(row = {}) {
  const template = textOrNull(row.template_id);
  return {
    channel: "email",
    notificationType: template,
    recipient: textOrNull(row.recipient),
    bookingId: textOrNull(row.booking_id) || bookingIdFromKey(row.idempotency_key),
    relationship: relationshipFromTemplate(template),
    relationshipId: null,
    provider: textOrNull(row.provider),
    providerMessageId: textOrNull(row.message_id),
    createdAt: timeValue(row.created_at),
    updatedAt: timeValue(row.updated_at),
    status: storedDeliveryStatus(row.status),
    storedStatus: textOrNull(row.status),
    retryCount: numberOrNull(row.retry_count),
    fallbackUsed: booleanOrNull(row.fallback_used),
    errorReason: textOrNull(row.error_reason) || textOrNull(row.error),
    template,
    reminderWindow: null,
    originatingApp: "barbers",
  };
}

export function mapSmsLog(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  return {
    channel: "sms",
    notificationType: textOrNull(row.category),
    recipient: textOrNull(row.to_e164),
    bookingId: textOrNull(row.booking_id) || bookingIdFromKey(row.idempotency_key),
    relationship: relationshipFromSms(row),
    relationshipId: textOrNull(row.user_id),
    provider: textOrNull(row.provider),
    providerMessageId: textOrNull(row.twilio_sid),
    createdAt: timeValue(row.created_at),
    updatedAt: timeValue(row.updated_at),
    status: storedDeliveryStatus(row.status),
    storedStatus: textOrNull(row.status),
    retryCount: numberOrNull(row.retry_count),
    fallbackUsed: booleanOrNull(row.fallback_used),
    errorReason: textOrNull(row.error_message) || textOrNull(row.error_code),
    template: textOrNull(row.category),
    reminderWindow: reminderWindowFromMetadata(metadata),
    originatingApp: "barbers",
  };
}

async function columnNames(dbQuery, table) {
  const result = await dbQuery(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return (result?.rows || []).map((row) => String(row.column_name || "")).filter(Boolean);
}

async function readTable(dbQuery, table, mapRow) {
  try {
    const columns = await columnNames(dbQuery, table);
    const sql = readOnlySelect(table, columns);
    if (!sql) return { available: false, records: [] };
    const result = await dbQuery(sql, []);
    return {
      available: true,
      records: (result?.rows || []).map(mapRow),
    };
  } catch {
    return { available: false, records: [] };
  }
}

export async function loadNotificationActivity(dbQuery) {
  if (typeof dbQuery !== "function") {
    return {
      ok: true,
      readOnly: true,
      email: { available: false, records: [] },
      sms: { available: false, records: [] },
    };
  }
  const [email, sms] = await Promise.all([
    readTable(dbQuery, "email_delivery_claims", mapEmailClaim),
    readTable(dbQuery, "sms_message_log", mapSmsLog),
  ]);
  return { ok: true, readOnly: true, email, sms };
}

export function createHqNotificationActivityRouter(options = {}) {
  const requireRead = options.requireRead || requireHqSnapshotRead;
  const load = options.loadActivity || (() => loadNotificationActivity(options.dbQuery));
  const router = express.Router();

  router.use("/notification-activity", (req, res, next) => {
    if (req.method === "GET") return next();
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  });

  router.get("/notification-activity", requireRead, async (_req, res) => {
    const payload = await load();
    res.json(payload);
  });

  return router;
}
