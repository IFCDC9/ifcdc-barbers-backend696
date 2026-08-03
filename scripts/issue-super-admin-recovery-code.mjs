#!/usr/bin/env node
/**
 * Issue a one-time Super Admin recovery login code for service@ifcdc.org.
 * Prints the code ONCE to stdout. Does not email. Does not commit the code.
 * Does NOT queue the code in pending_email_deliveries.
 *
 *   node --import ./loadBackendEnv.mjs scripts/issue-super-admin-recovery-code.mjs
 *
 * Optional password confirmation (recommended):
 *   SUPER_ADMIN_PASSWORD='…' node --import ./loadBackendEnv.mjs scripts/issue-super-admin-recovery-code.mjs
 *
 * Never pass the code on the command line in CI logs you will retain.
 */
import { writeSecurityAudit } from "../auditSecurity.js";
import { comparePassword } from "../authPasswordPolicy.js";
import { normalizeEmail } from "../authStore.js";
import { CANONICAL_SUPER_ADMIN_EMAIL, isSuperAdminEmail } from "../rolePolicy.js";
import { createRequire } from "module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const {
  issueSuperAdminLoginChallenge,
  ensureSuperAdminLoginChallengeTable,
  isOutageRecoveryEnabled,
} = require("../superAdminLoginChallenge.cjs");

const email = normalizeEmail(CANONICAL_SUPER_ADMIN_EMAIL);
if (!isSuperAdminEmail(email)) {
  console.error("Canonical Super Admin email misconfigured");
  process.exit(1);
}

await ensureSuperAdminLoginChallengeTable(dbQuery);

const found = await dbQuery(
  `SELECT id, email, role, password_hash
   FROM app_users
   WHERE lower(trim(email::text)) = $1
   LIMIT 1`,
  [email],
);
const user = found.rows?.[0];
if (!user) {
  console.error("Super Admin account not found in production DB:", email);
  process.exit(1);
}
if (String(user.role || "").toLowerCase() !== "super_admin") {
  console.error("Account exists but role is not super_admin:", user.role);
  process.exit(1);
}

let password = String(process.env.SUPER_ADMIN_PASSWORD || "").trim();
if (!password && process.stdin.isTTY) {
  password = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Confirm Super Admin password (input hidden not supported — type carefully): ", (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

if (password) {
  const ok = await comparePassword(password, user.password_hash);
  if (!ok) {
    console.error("Password confirmation failed — code not issued.");
    process.exit(1);
  }
} else {
  console.warn(
    "[warn] SUPER_ADMIN_PASSWORD not set — issuing code after DB role check only. Prefer confirming the password.",
  );
}

const issued = await issueSuperAdminLoginChallenge(dbQuery, {
  userId: user.id,
  email,
  delivery: "outage_recovery_script",
  metadata: { source: "issue-super-admin-recovery-code" },
});

if (!issued.ok) {
  console.error("Failed to issue challenge:", issued.error);
  process.exit(1);
}

await writeSecurityAudit({
  eventType: "super_admin_recovery_code_issued",
  actorUserId: user.id,
  actorEmail: email,
  metadata: {
    challengeId: issued.challengeId,
    expiresInSec: issued.expiresInSec,
    outageRecovery: isOutageRecoveryEnabled(),
    // plaintext code intentionally omitted from audit
  },
});

console.error("────────────────────────────────────────");
console.error("Super Admin recovery code issued");
console.error(`Email: ${email}`);
console.error(`Challenge: ${issued.challengeId}`);
console.error(`Expires in: ${issued.expiresInSec}s (single use)`);
console.error("Enter this code in the app with your password.");
console.error("────────────────────────────────────────");
// Plaintext code only on stdout so operators can redirect/capture deliberately.
process.stdout.write(`${issued.code}\n`);
process.exit(0);
