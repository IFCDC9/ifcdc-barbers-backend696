import { dbQuery } from "./db.js";

/**
 * Canonical appointment lifecycle. Order matters for the timeline display.
 */
export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
  "rescheduled",
];

const STATUS_SET = new Set(BOOKING_STATUSES);

/** Terminal states — only super_admin / admin can move out of these. */
export const FINAL_STATUSES = new Set(["completed", "cancelled", "no_show"]);

/**
 * Per-role allowed transitions: ROLE_TRANSITIONS[role][from] = Set(toStatuses).
 * super_admin / admin override the matrix entirely (see canTransition).
 */
const ROLE_TRANSITIONS = {
  customer: {
    pending: new Set(["cancelled", "rescheduled"]),
    confirmed: new Set(["cancelled", "rescheduled"]),
    checked_in: new Set([]),
    in_progress: new Set([]),
    rescheduled: new Set(["cancelled"]),
    completed: new Set([]),
    cancelled: new Set([]),
    no_show: new Set([]),
  },
  barber: {
    pending: new Set(["confirmed", "cancelled", "rescheduled"]),
    confirmed: new Set([
      "checked_in",
      "in_progress",
      "completed",
      "no_show",
      "cancelled",
      "rescheduled",
    ]),
    checked_in: new Set(["in_progress", "completed", "no_show", "cancelled"]),
    in_progress: new Set(["completed", "cancelled"]),
    rescheduled: new Set(["confirmed", "cancelled"]),
    completed: new Set([]),
    cancelled: new Set([]),
    no_show: new Set([]),
  },
  shop_owner: {
    pending: new Set(["confirmed", "cancelled", "rescheduled"]),
    confirmed: new Set([
      "checked_in",
      "in_progress",
      "completed",
      "no_show",
      "cancelled",
      "rescheduled",
    ]),
    checked_in: new Set(["in_progress", "completed", "no_show", "cancelled"]),
    in_progress: new Set(["completed", "cancelled"]),
    rescheduled: new Set(["confirmed", "checked_in", "cancelled"]),
    completed: new Set([]),
    cancelled: new Set([]),
    no_show: new Set([]),
  },
};

/** Customer-friendly labels for action buttons + alerts. */
export const STATUS_LABELS = {
  pending: "Pending",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
  rescheduled: "Rescheduled",
};

export function isValidStatus(s) {
  return STATUS_SET.has(String(s || "").toLowerCase());
}

/**
 * Decide whether `role` may move a booking from `from` → `to`.
 *
 * @param {{ from: string, to: string, role: string, isPlatformSuper?: boolean }} p
 * @returns {{ ok: true, override?: boolean } | { ok: false, reason: string }}
 */
export function canTransition({ from, to, role, isPlatformSuper = false }) {
  const f = String(from || "").toLowerCase();
  const t = String(to || "").toLowerCase();
  const r = String(role || "").toLowerCase();

  if (!isValidStatus(t)) return { ok: false, reason: "invalid_target_status" };
  if (!f) return { ok: false, reason: "missing_current_status" };
  if (f === t) return { ok: false, reason: "no_change" };

  if (isPlatformSuper || r === "super_admin" || r === "admin") {
    return { ok: true, override: true };
  }

  const matrix = ROLE_TRANSITIONS[r];
  if (!matrix) return { ok: false, reason: "role_not_allowed" };
  const allowedTargets = matrix[f];
  if (!allowedTargets) return { ok: false, reason: "transition_not_allowed" };
  if (allowedTargets.has(t)) return { ok: true };
  return { ok: false, reason: "transition_not_allowed" };
}

/**
 * Best-effort timeline write. Audit failures must NEVER block the actual status mutation.
 *
 * @param {{
 *   bookingId: string,
 *   previousStatus?: string|null,
 *   newStatus: string,
 *   actor?: { userId?: string|null, role?: string|null, email?: string|null } | null,
 *   note?: string|null,
 * }} entry
 */
export async function recordStatusChange(entry) {
  try {
    await ensureBookingStatusHistoryTable();
    await dbQuery(
      `INSERT INTO booking_status_history
         (booking_id, previous_status, new_status, changed_by_user_id, changed_by_role, changed_by_email, note)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7)`,
      [
        String(entry.bookingId),
        entry.previousStatus ? String(entry.previousStatus).slice(0, 40) : null,
        String(entry.newStatus).slice(0, 40),
        entry.actor?.userId ? String(entry.actor.userId).slice(0, 64) : null,
        entry.actor?.role ? String(entry.actor.role).slice(0, 40) : null,
        entry.actor?.email ? String(entry.actor.email).slice(0, 320) : null,
        entry.note ? String(entry.note).slice(0, 1000) : null,
      ],
    );
    console.log(
      `[booking_status] booking=${String(entry.bookingId).slice(0, 8)} ${entry.previousStatus || "—"} → ${entry.newStatus} actor=${entry.actor?.email || entry.actor?.role || "—"}`,
    );
    const nextStatus = String(entry.newStatus || "").toLowerCase();
    if (nextStatus === "cancelled" || nextStatus === "no_show") {
      const loyalty = await import("./loyaltyService.js");
      const loyaltyActor = {
        id: entry.actor?.userId || null,
        email: entry.actor?.email || null,
        role: entry.actor?.role || null,
      };
      await loyalty.restoreRewardForBooking(entry.bookingId, {
        actor: loyaltyActor,
        reason: nextStatus,
      }).catch((error) => console.warn("[loyalty] reward restore:", error?.message || error));

      const booking = await dbQuery(
        `SELECT payment_status, refunded_at FROM bookings WHERE id = $1::uuid LIMIT 1`,
        [String(entry.bookingId)],
      ).catch(() => ({ rows: [] }));
      const paymentStatus = String(booking.rows?.[0]?.payment_status || "").toLowerCase();
      if (booking.rows?.[0]?.refunded_at || paymentStatus.includes("refund")) {
        await loyalty.reverseLoyaltyForBooking(entry.bookingId, {
          actor: loyaltyActor,
          reason: "booking_refunded",
        }).catch((error) => console.warn("[loyalty] points reversal:", error?.message || error));
      }
    }
  } catch (e) {
    console.warn("[booking_status_history] insert failed:", e?.message || e);
  }
}

let tableReady = false;

export async function ensureBookingStatusHistoryTable() {
  if (tableReady) return;
  try {
    await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS booking_status_history (
        id BIGSERIAL PRIMARY KEY,
        booking_id UUID NOT NULL,
        previous_status TEXT,
        new_status TEXT NOT NULL,
        changed_by_user_id UUID,
        changed_by_role TEXT,
        changed_by_email TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        note TEXT
      );
    `);
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS booking_status_history_booking_idx ON booking_status_history (booking_id)`,
    );
    await dbQuery(
      `CREATE INDEX IF NOT EXISTS booking_status_history_changed_idx ON booking_status_history (changed_at DESC)`,
    );
    tableReady = true;
  } catch (e) {
    console.warn("[migrate] ensureBookingStatusHistoryTable:", e?.message || e);
  }
}

/**
 * Returns the timeline for a booking. Synthesizes a "Booked → confirmed" row
 * from bookings.created_at when the history table has no entries yet (so a
 * legacy booking still shows a meaningful timeline).
 */
export async function loadStatusTimeline(bookingId, fallback) {
  await ensureBookingStatusHistoryTable();
  const r = await dbQuery(
    `SELECT id, previous_status, new_status, changed_by_user_id, changed_by_role, changed_by_email, changed_at, note
     FROM booking_status_history
     WHERE booking_id = $1::uuid
     ORDER BY changed_at ASC, id ASC`,
    [String(bookingId)],
  );
  const rows = r.rows || [];
  if (rows.length > 0) return rows;
  if (fallback?.created_at && fallback?.booking_status) {
    return [
      {
        id: null,
        previous_status: null,
        new_status: String(fallback.booking_status),
        changed_by_user_id: null,
        changed_by_role: "system",
        changed_by_email: null,
        changed_at: fallback.created_at,
        note: "Initial booking",
        synthetic: true,
      },
    ];
  }
  return [];
}
