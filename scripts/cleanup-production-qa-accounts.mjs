#!/usr/bin/env node
/**
 * Permanently remove QA / release-validation barbers, owners, and shops from production.
 * Requires DATABASE_URL (backend/.env or Render shell).
 *
 * Usage:
 *   node scripts/cleanup-production-qa-accounts.mjs
 *   IFCDC_DRY_RUN=1 node scripts/cleanup-production-qa-accounts.mjs
 */
import "../loadBackendEnv.mjs";
import { createRequire } from "node:module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { isQaTestEmail, isQaTestLabel } = require("../barberBookingPolicy.cjs");

const dryRun = String(process.env.IFCDC_DRY_RUN || "").trim() === "1";

const QA_BARBER_SQL = `
  SELECT b.id, b.name, b.shop_name, b.user_id, u.email AS user_email
  FROM barbers b
  LEFT JOIN app_users u ON u.id = b.user_id
  WHERE lower(coalesce(b.name, '')) LIKE '%release test%'
    OR lower(coalesce(b.name, '')) LIKE '%rv test%'
    OR lower(coalesce(b.name, '')) LIKE '%rv reject%'
    OR lower(coalesce(b.name, '')) LIKE '%qa multi%'
    OR lower(coalesce(b.name, '')) LIKE 'qa %'
    OR lower(coalesce(b.shop_name, '')) LIKE 'rv barber shop%'
    OR lower(coalesce(b.shop_name, '')) LIKE 'rv reject shop%'
    OR lower(coalesce(b.shop_name, '')) LIKE 'rv business%'
    OR lower(coalesce(u.email, '')) LIKE 'rv-%'
    OR lower(coalesce(u.email, '')) LIKE 'rv_%'
    OR lower(coalesce(u.email, '')) LIKE 'release-%'
    OR lower(coalesce(u.email, '')) LIKE 'qa-multi-%'
    OR lower(coalesce(u.email, '')) LIKE 'qa-%'
`;

const QA_USER_SQL = `
  SELECT id, email, name, role, business_id, barber_id
  FROM app_users
  WHERE lower(coalesce(email, '')) LIKE 'rv-%'
    OR lower(coalesce(email, '')) LIKE 'rv_%'
    OR lower(coalesce(email, '')) LIKE 'release-%'
    OR lower(coalesce(email, '')) LIKE 'qa-multi-%'
    OR lower(coalesce(email, '')) LIKE 'qa-%'
    OR lower(coalesce(name, '')) LIKE '%release test%'
    OR lower(coalesce(name, '')) LIKE '%rv test%'
    OR lower(coalesce(name, '')) LIKE '%rv reject%'
`;

const QA_BUSINESS_SQL = `
  SELECT id, name
  FROM businesses
  WHERE lower(coalesce(name, '')) LIKE 'rv barber shop%'
    OR lower(coalesce(name, '')) LIKE 'rv reject shop%'
    OR lower(coalesce(name, '')) LIKE 'rv business%'
    OR lower(coalesce(name, '')) LIKE '%release test%'
`;

async function purgeBarber(barberId, { deleteUserId = null } = {}) {
  const id = String(barberId);
  await dbQuery(`DELETE FROM bookings WHERE barber_id::text = $1::text`, [id]).catch(() => {});
  for (const table of [
    "barber_services",
    "barber_settings",
    "barber_availability",
    "barber_availability_breaks",
    "barber_blocked_dates",
    "barber_clients",
    "barber_portfolio_images",
    "barber_styles",
    "styles",
  ]) {
    await dbQuery(`DELETE FROM ${table} WHERE barber_id::text = $1::text`, [id]).catch(() => {});
  }
  await dbQuery(`DELETE FROM barber_profiles WHERE id::text = $1::text`, [id]).catch(() => {});
  await dbQuery(`UPDATE app_users SET barber_id = NULL WHERE barber_id::text = $1::text`, [id]).catch(() => {});
  await dbQuery(`DELETE FROM barbers WHERE id::text = $1::text`, [id]);
  if (deleteUserId) {
    await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid`, [deleteUserId]).catch(() => {});
  }
}

console.log(dryRun ? "\n[DRY RUN] Production QA account cleanup\n" : "\nProduction QA account cleanup\n");

const qaBarbers = await dbQuery(QA_BARBER_SQL);
const qaUsers = await dbQuery(QA_USER_SQL);
const qaBusinesses = await dbQuery(QA_BUSINESS_SQL);

console.log(`QA barbers: ${qaBarbers.rows?.length ?? 0}`);
for (const row of qaBarbers.rows || []) {
  console.log(`  barber id=${row.id} name=${row.name} email=${row.user_email || "—"}`);
}
console.log(`QA users: ${qaUsers.rows?.length ?? 0}`);
for (const row of qaUsers.rows || []) {
  console.log(`  user id=${row.id} email=${row.email} role=${row.role}`);
}
console.log(`QA businesses: ${qaBusinesses.rows?.length ?? 0}`);
for (const row of qaBusinesses.rows || []) {
  console.log(`  business id=${row.id} name=${row.name}`);
}

if (dryRun) {
  console.log("\nRe-run without IFCDC_DRY_RUN=1 to delete.\n");
  process.exit(0);
}

for (const row of qaBarbers.rows || []) {
  const qaUser =
    row.user_id && (isQaTestEmail(row.user_email) || isQaTestLabel(row.name) || isQaTestLabel(row.shop_name));
  await purgeBarber(row.id, { deleteUserId: qaUser ? row.user_id : null });
  console.log(`Purged barber id=${row.id} (${row.name})`);
}

const purgedUserIds = new Set((qaBarbers.rows || []).map((r) => r.user_id).filter(Boolean));
for (const row of qaUsers.rows || []) {
  if (purgedUserIds.has(row.id)) continue;
  await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid`, [row.id]);
  console.log(`Deleted QA user id=${row.id} (${row.email})`);
}

for (const row of qaBusinesses.rows || []) {
  await dbQuery(`DELETE FROM businesses WHERE id = $1::bigint`, [Number(row.id)]).catch(async () => {
    await dbQuery(
      `UPDATE businesses SET account_status = 'disabled', approval_status = 'rejected' WHERE id = $1::bigint`,
      [Number(row.id)],
    );
  });
  console.log(`Removed QA business id=${row.id} (${row.name})`);
}

console.log("\nQA cleanup complete.\n");
process.exit(0);
