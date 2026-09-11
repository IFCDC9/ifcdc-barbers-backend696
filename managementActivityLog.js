/**
 * Management activity audit log (Super Admin reviewable).
 */
import { dbQuery } from "./db.js";
import { writeSecurityAudit } from "./auditSecurity.js";

export async function logManagementActivity({
  actorUserId = null,
  actorEmail = null,
  actorAssignmentId = null,
  action,
  businessId = null,
  locationId = null,
  recordType = null,
  recordId = null,
  beforeValue = null,
  afterValue = null,
  metadata = {},
  req = null,
} = {}) {
  const actionKey = String(action || "management_action").trim();
  try {
    await dbQuery(
      `INSERT INTO management_activity_log (
         actor_user_id, actor_email, actor_assignment_id, action,
         business_id, location_id, record_type, record_id,
         before_value, after_value, metadata
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4,
         $5::bigint, $6::uuid, $7, $8,
         $9::jsonb, $10::jsonb, $11::jsonb
       )`,
      [
        actorUserId || null,
        actorEmail ? String(actorEmail).trim() : null,
        actorAssignmentId || null,
        actionKey,
        businessId != null && businessId !== "" ? Number(businessId) : null,
        locationId || null,
        recordType || null,
        recordId != null ? String(recordId) : null,
        beforeValue != null ? JSON.stringify(beforeValue) : null,
        afterValue != null ? JSON.stringify(afterValue) : null,
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
      ],
    );
  } catch (e) {
    console.warn("[management-audit] insert failed:", e?.message || e);
  }

  void writeSecurityAudit({
    eventType: `management_${actionKey}`,
    actorUserId,
    actorEmail,
    req,
    metadata: {
      actorAssignmentId,
      businessId,
      locationId,
      recordType,
      recordId,
      beforeValue,
      afterValue,
      ...(metadata || {}),
    },
  });

  return { ok: true };
}

export async function listManagementActivityLogs({
  limit = 100,
  offset = 0,
  actorUserId = null,
  businessId = null,
  action = null,
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const params = [];
  const where = [];
  if (actorUserId) {
    params.push(String(actorUserId));
    where.push(`actor_user_id = $${params.length}::uuid`);
  }
  if (businessId != null && businessId !== "") {
    params.push(Number(businessId));
    where.push(`business_id = $${params.length}::bigint`);
  }
  if (action) {
    params.push(String(action));
    where.push(`action = $${params.length}`);
  }
  params.push(lim, off);
  const sql = `
    SELECT *
    FROM management_activity_log
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const r = await dbQuery(sql, params);
  return r.rows || [];
}
