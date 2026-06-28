#!/usr/bin/env node
/**
 * Provision a dedicated platform QA administrator (role: admin, NOT super_admin).
 * Keeps service@ifcdc.org super_admin reserved for production ownership.
 *
 * Usage:
 *   QA_ADMIN_PASSWORD='YourStr0ng!Secret' node scripts/provision-qa-admin.mjs
 *   QA_ADMIN_EMAIL=qa-validation@ifcdcbarbersapp.com QA_ADMIN_PASSWORD='…' node scripts/provision-qa-admin.mjs
 *
 * Optional: QA_ADMIN_PASSWORD with --generate to print a generated password once.
 */
import "../loadBackendEnv.mjs";
import crypto from "node:crypto";
import { dbQuery } from "../db.js";
import { hashPassword, validatePasswordStrength } from "../authPasswordPolicy.js";
import { normalizeEmail } from "../authStore.js";

const DEFAULT_QA_EMAIL = "qa-validation@ifcdcbarbersapp.com";
const email = normalizeEmail(process.env.QA_ADMIN_EMAIL || DEFAULT_QA_EMAIL);
const generateFlag = process.argv.includes("--generate") || process.argv.includes("-g");

function generateSecurePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*-_+=.";
  const pick = (chars, n) =>
    Array.from(crypto.randomFillSync(new Uint8Array(n)), (b) => chars[b % chars.length]).join("");
  const chars = [pick(upper, 4), pick(lower, 6), pick(digits, 3), pick(symbols, 3)].join("").split("");
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const pwd = chars.join("");
  if (!validatePasswordStrength(pwd).valid) return generateSecurePassword();
  return pwd;
}

function resolvePlainPassword() {
  const fromEnv = String(process.env.QA_ADMIN_PASSWORD || "").trim();
  if (fromEnv) return { password: fromEnv, source: "env" };
  if (generateFlag) return { password: generateSecurePassword(), source: "generated" };
  return { password: "", source: "missing" };
}

async function upsertQaAdmin(passwordHash) {
  const updated = await dbQuery(
    `UPDATE app_users
     SET password_hash = $1,
         role = 'admin',
         name = COALESCE(NULLIF(TRIM(name::text), ''), 'IFCDC QA Validation')
     WHERE lower(trim(email::text)) = lower(trim($2::text))
     RETURNING id, name, email, role`,
    [passwordHash, email],
  );
  if (updated.rows?.length) return { created: false, user: updated.rows[0] };

  const inserted = await dbQuery(
    `INSERT INTO app_users (name, email, password_hash, role)
     VALUES ('IFCDC QA Validation', $1, $2, 'admin')
     RETURNING id, name, email, role`,
    [email, passwordHash],
  );
  return { created: true, user: inserted.rows[0] };
}

const { password, source } = resolvePlainPassword();
if (!password) {
  console.error(
    "Set QA_ADMIN_PASSWORD or run with --generate.\nExample:\n  QA_ADMIN_PASSWORD='…' node scripts/provision-qa-admin.mjs",
  );
  process.exit(1);
}

const strength = validatePasswordStrength(password);
if (!strength.valid) {
  console.error("Password too weak:", strength.message || strength.reason);
  process.exit(1);
}

const hash = await hashPassword(password);
const { created, user } = await upsertQaAdmin(hash);

console.log(`\nQA admin ${created ? "created" : "updated"}:`);
console.log(`  email: ${user.email}`);
console.log(`  role:  ${user.role}`);
console.log(`  id:    ${user.id}`);
if (source === "generated") {
  console.log(`\nGenerated password (store securely — shown once):\n  ${password}\n`);
}
console.log(
  "Use for release-validation:\n" +
    `  QA_ADMIN_EMAIL=${email} QA_ADMIN_PASSWORD='…' node scripts/release-validation.mjs\n`,
);
