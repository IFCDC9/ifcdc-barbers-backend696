/**
 * Permanently delete an app_users account and scrub linked personal data (App Store 5.1.1(v)).
 */
import { dbQuery } from "./db.js";
import { isSuperAdminEmail } from "./rolePolicy.js";

/**
 * @param {string} userId — app_users.id (uuid)
 * @returns {Promise<{ ok: true } | { ok: false, error: string, message?: string }>}
 */
export async function deleteAppUserAccount(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    return { ok: false, error: "invalid_user", message: "Invalid account." };
  }

  const found = await dbQuery(
    `SELECT id, email, role FROM app_users WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  const user = found.rows?.[0];
  if (!user) {
    return { ok: false, error: "user_not_found", message: "Account not found." };
  }

  const email = String(user.email || "").trim().toLowerCase();
  if (user.role === "super_admin" || isSuperAdminEmail(email)) {
    return {
      ok: false,
      error: "account_protected",
      message: "This platform account cannot be deleted from the app.",
    };
  }

  const anonEmail = `deleted-${id.replace(/-/g, "").slice(0, 12)}@privacy.ifcdc.invalid`;
  const anonName = "Deleted User";

  await dbQuery(
    `UPDATE bookings
     SET user_id = NULL,
         customer_email = $2,
         customer_name = $3,
         phone = NULL,
         notes = CASE WHEN notes IS NOT NULL AND btrim(notes) <> '' THEN '[account deleted]' ELSE notes END
     WHERE user_id = $1::uuid`,
    [id, anonEmail, anonName],
  );

  await dbQuery(`DELETE FROM legal_acceptances WHERE user_id = $1::uuid`, [id]).catch(() => {});

  await dbQuery(
    `UPDATE booking_status_history
     SET changed_by_user_id = NULL,
         changed_by_email = $2
     WHERE changed_by_user_id = $1::uuid`,
    [id, anonEmail],
  ).catch(() => {});

  await dbQuery(`DELETE FROM pending_user_invites WHERE lower(trim(email)) = $1`, [email]).catch(() => {});

  await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid`, [id]);

  return { ok: true };
}
