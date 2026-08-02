#!/usr/bin/env node
/**
 * Post-deploy production verification for AURA review-followup hardening.
 * Uses live Mark Complete on ifcdc-barbers-backend696. No flag changes.
 */
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const API = String(process.env.AURA_API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const EXPECTED_COMMIT = String(process.env.EXPECTED_COMMIT || "297f0c48").slice(0, 8);
const CUSTOMER_EMAIL = String(
  process.env.AURA_TEST_CUSTOMER_EMAIL || process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org",
).trim();
const ADMIN_KEY = String(process.env.ADMIN_SECRET || process.env.VITE_ADMIN_API_KEY || "").trim();
const BARBER_ID = "3df86e72-8999-4633-bca7-2274b57b5b4f";
const BARBER_NAME = "IFCDC Barbers";
const marker = `controlled_review_followup_prod_verify_${Date.now()}`;
const OWNER_EMAIL = String(process.env.SUPER_ADMIN_EMAIL || "service@ifcdc.org").trim();

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

async function resolveAdminBearer() {
  if (process.env.AURA_ADMIN_BEARER) return String(process.env.AURA_ADMIN_BEARER).trim();
  try {
    const fs = await import("node:fs");
    const fromFile = String(fs.readFileSync("/tmp/aura-prod-admin-token.txt", "utf8") || "").trim();
    if (fromFile) return fromFile;
  } catch {
    /* optional */
  }
  const password = String(
    process.env.SUPER_ADMIN_PASSWORD ||
      process.env.QA_ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD ||
      process.env.AURA_OWNER_PASSWORD ||
      "",
  ).trim();
  if (!password) return "";
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password }),
  });
  const json = await res.json().catch(() => ({}));
  return String(json.token || json.accessToken || "").trim();
}

function slotStrings(minutesAgo) {
  const startAt = new Date(Date.now() - minutesAgo * 60 * 1000);
  const yyyy = startAt.getUTCFullYear();
  const mm = String(startAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(startAt.getUTCDate()).padStart(2, "0");
  const hh = String(startAt.getUTCHours()).padStart(2, "0");
  const mi = String(startAt.getUTCMinutes()).padStart(2, "0");
  const ss = String(startAt.getUTCSeconds()).padStart(2, "0");
  return { dateStr: `${yyyy}-${mm}-${dd}`, timeStr: `${hh}:${mi}:${ss}` };
}

async function insertBooking(status, nameSuffix, minutesAgo) {
  const { dateStr, timeStr } = slotStrings(minutesAgo);
  const r = await dbQuery(
    `INSERT INTO bookings (
        customer_name, customer_email, barber_id, barber_name, service,
        date, time, amount, payment_status, booking_status, is_paid_booking,
        total_price, notes
      ) VALUES (
        $1, $2, $3::uuid, $4, $5,
        $6::date, $7::time, 35, 'paid', $8, true,
        35, $9
      )
      RETURNING id, booking_status, customer_email, review_prompt_sent_at`,
    [
      `AURA Review Followup Prod Verify (${nameSuffix})`,
      CUSTOMER_EMAIL,
      BARBER_ID,
      BARBER_NAME,
      "Controlled production Mark Complete verification",
      dateStr,
      timeStr,
      status,
      `AURA Phase 2 production review follow-up verify marker=${marker} role=${nameSuffix}`,
    ],
  );
  return r.rows?.[0];
}

async function markComplete(bookingId, bearer) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (ADMIN_KEY) headers["x-admin-key"] = ADMIN_KEY;
  const res = await fetch(`${API}/api/admin/bookings/${encodeURIComponent(bookingId)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      action: "complete",
      note: `controlled_prod_verify marker=${marker}`,
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 800) };
  }
  return { status: res.status, json };
}

const health = await getJson("/api/health");
const deploy = await getJson("/api/deploy-info");
const flags = await getJson("/api/aura/phase2/status");
const activeShort = String(deploy.json?.activeCommitShort || deploy.json?.activeCommit || "").slice(0, 8);
const bearer = await resolveAdminBearer();

if (!bearer && !ADMIN_KEY) {
  console.error(JSON.stringify({ ok: false, error: "admin_auth_missing" }, null, 2));
  process.exit(1);
}

const confirmedBefore = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM bookings WHERE lower(coalesce(booking_status,'')) = 'confirmed'`,
);

const primary = await insertBooking("confirmed", "complete", 71);
const cancelled = await insertBooking("cancelled", "cancelled", 72);
const noShow = await insertBooking("no_show", "no_show", 73);
const incomplete = await insertBooking("confirmed", "incomplete", 74);

if (!primary?.id) {
  console.error(JSON.stringify({ ok: false, error: "insert_failed" }, null, 2));
  process.exit(1);
}

const firstComplete = await markComplete(primary.id, bearer);
await new Promise((r) => setTimeout(r, 2500));
const secondComplete = await markComplete(primary.id, bearer);

// Negative cases: do NOT mark cancelled/no-show complete via API (that would change status).
// Exercise the production-deployed hook semantics against those statuses.
process.env.AURA_PHASE2_ENABLED = "true";
process.env.AURA_PHASE2_REVIEW_FOLLOWUP = "true";
const { afterBookingCompleted } = require("../auraPhase2Hooks.cjs");
const cancelledOut = await afterBookingCompleted(dbQuery, { id: cancelled.id });
const noShowOut = await afterBookingCompleted(dbQuery, { id: noShow.id });
const incompleteOut = await afterBookingCompleted(dbQuery, { id: incomplete.id });
const cancelledComplete = { skippedHook: cancelledOut };
const noShowComplete = { skippedHook: noShowOut };
const incompleteAttempt = incompleteOut;

await new Promise((r) => setTimeout(r, 800));

const primaryAfter = await dbQuery(
  `SELECT id, booking_status, customer_email, barber_name, service,
          date::text AS date, to_char(time, 'HH12:MI AM') AS time_ampm,
          review_prompt_sent_at, completed_at
   FROM bookings WHERE id = $1::uuid`,
  [primary.id],
);
const primaryRow = primaryAfter.rows?.[0];

const sentLogs = await dbQuery(
  `SELECT id, result, metadata, created_at
   FROM aura_action_logs
   WHERE booking_id = $1::uuid AND action = 'review_followup' AND result = 'sent'
   ORDER BY created_at ASC`,
  [primary.id],
);

const reviewPromptLegacyLogs = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM notification_delivery_logs
   WHERE booking_id = $1::uuid
     AND kind = 'review_prompt'
     AND created_at > NOW() - INTERVAL '15 minutes'`,
  [primary.id],
);

const unintended = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'review_followup'
     AND result = 'sent'
     AND created_at > NOW() - INTERVAL '15 minutes'
     AND booking_id IS DISTINCT FROM $1::uuid
     AND booking_id NOT IN (
       SELECT id FROM bookings
       WHERE COALESCE(notes, '') LIKE '%controlled_review_followup%'
          OR COALESCE(customer_name, '') LIKE 'AURA %'
     )`,
  [primary.id],
);

const cancelledSent = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM aura_action_logs
   WHERE booking_id = ANY($1::uuid[]) AND action = 'review_followup' AND result = 'sent'`,
  [[cancelled.id, noShow.id, incomplete.id]],
);

for (const id of [primary.id, cancelled.id, noShow.id, incomplete.id]) {
  await dbQuery(
    `UPDATE bookings
     SET booking_status = 'cancelled',
         notes = COALESCE(notes, '') || ' | cleaned_after_prod_review_followup_verify'
     WHERE id = $1::uuid`,
    [id],
  );
}

const confirmedAfter = await dbQuery(
  `SELECT COUNT(*)::int AS c FROM bookings WHERE lower(coalesce(booking_status,'')) = 'confirmed'`,
);

const f = flags.json?.flags || {};
const checks = {
  healthOk: health.status === 200 && (health.json?.status === "OK" || health.json?.ok === true),
  deployCommitMatch: activeShort === EXPECTED_COMMIT,
  reviewFollowupStillTrue: f.reviewFollowup === true,
  toolsStillFalse: f.toolsEnabled === false,
  dailyPreviewFalse: f.dailyReportPreview === false,
  dailySendFalse: f.dailyReportSend === false,
  firstMarkCompleteOk: firstComplete.status === 200 && firstComplete.json?.ok === true,
  firstCompletionWasNew: firstComplete.json?.alreadyCompleted !== true,
  secondMarkCompleteAlreadyDone:
    secondComplete.status === 200 &&
    (secondComplete.json?.alreadyCompleted === true ||
      String(secondComplete.json?.message || "").toLowerCase().includes("already")),
  reviewPromptTimestampSet: Boolean(primaryRow?.review_prompt_sent_at),
  bookingCompleted: String(primaryRow?.booking_status || "").toLowerCase() === "completed",
  exactlyOneSentLog: (sentLogs.rows || []).length === 1,
  legacyReviewPromptSkipped: Number(reviewPromptLegacyLogs.rows?.[0]?.c || 0) === 0,
  cancelledNoShowIncompleteNoSent: Number(cancelledSent.rows?.[0]?.c || 0) === 0,
  incompleteSkippedNotCompleted:
    incompleteAttempt?.skipped === true && incompleteAttempt?.reason === "not_completed",
  cancelledSkipped:
    cancelledOut?.skipped === true && cancelledOut?.reason === "status_excluded",
  noShowSkipped: noShowOut?.skipped === true && noShowOut?.reason === "status_excluded",
  noUnintendedRealCustomerSends: Number(unintended.rows?.[0]?.c || 0) === 0,
  confirmedCountRestored:
    Number(confirmedBefore.rows?.[0]?.c || 0) === Number(confirmedAfter.rows?.[0]?.c || -1),
  emailSink: CUSTOMER_EMAIL.toLowerCase() === "service@ifcdc.org",
};

const pass = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok: pass,
      verdict: pass ? "PASS" : "FAIL",
      feature: "AURA_PHASE2_REVIEW_FOLLOWUP_PROD_DEPLOY",
      expectedCommit: EXPECTED_COMMIT,
      activeCommit: activeShort,
      marker,
      bookingId: primary.id,
      firstComplete,
      secondComplete,
      cancelledComplete: { status: cancelledComplete.status, json: cancelledComplete.json },
      noShowComplete: { status: noShowComplete.status, json: noShowComplete.json },
      incompleteAttempt,
      primaryRow,
      sentLog: sentLogs.rows?.[0] || null,
      legacyReviewPromptCount: reviewPromptLegacyLogs.rows?.[0]?.c,
      flags: f,
      checks,
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
