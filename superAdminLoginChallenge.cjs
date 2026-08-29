/**
 * Super Admin login step-up challenges (service@ifcdc.org only).
 * Codes are stored hashed only — never logged or committed in plaintext.
 * Auth OTP / login codes must NEVER be written to pending_email_deliveries.
 */
const crypto = require("node:crypto");

const CANONICAL_SUPER_ADMIN_EMAIL = "service@ifcdc.org";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 6;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function isSuperAdminEmail(email) {
  return normalizeEmail(email) === normalizeEmail(CANONICAL_SUPER_ADMIN_EMAIL);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function generateNumericCode(length = CODE_LENGTH) {
  const n = Math.max(4, Math.min(8, Number(length) || CODE_LENGTH));
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
}

/**
 * Outage recovery: ops script may issue the code when Resend cannot deliver.
 * Default ON until Resend is restored — then set SUPER_ADMIN_EMAIL_OUTAGE_RECOVERY=0.
 */
function isOutageRecoveryEnabled() {
  const raw = String(process.env.SUPER_ADMIN_EMAIL_OUTAGE_RECOVERY ?? "1")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

/** Super Admin login step-up is OFF by default. Set SUPER_ADMIN_LOGIN_STEPUP=1 to restore SMS verification. */
function isSuperAdminLoginStepUpEnabled() {
  const off = String(process.env.SUPER_ADMIN_LOGIN_STEPUP ?? "0").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off") return false;
  return true;
}

async function ensureSuperAdminLoginChallengeTable(dbQuery) {
  if (typeof dbQuery !== "function") return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS super_admin_login_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id UUID NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      delivery TEXT,
      last_error TEXT,
      metadata JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS super_admin_login_challenges_open_idx
     ON super_admin_login_challenges (email, created_at DESC)
     WHERE consumed_at IS NULL`,
  );
}

/**
 * Invalidate open challenges and create a fresh one-time code (plaintext returned once to caller).
 * Caller must deliver via email OR outage recovery script — never queue as pending email.
 */
async function issueSuperAdminLoginChallenge(
  dbQuery,
  { userId, email, delivery = "email", metadata = null } = {},
) {
  if (typeof dbQuery !== "function") return { ok: false, error: "db_unavailable" };
  const em = normalizeEmail(email);
  if (!isSuperAdminEmail(em)) {
    return { ok: false, error: "not_super_admin_email" };
  }
  if (em !== normalizeEmail(CANONICAL_SUPER_ADMIN_EMAIL)) {
    return { ok: false, error: "not_canonical_super_admin" };
  }
  await ensureSuperAdminLoginChallengeTable(dbQuery);
  const code = generateNumericCode(6);
  const codeHash = sha256Hex(`${em}:${code}`);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await dbQuery(
    `UPDATE super_admin_login_challenges
     SET consumed_at = NOW(), updated_at = NOW()
     WHERE lower(trim(email)) = $1 AND consumed_at IS NULL`,
    [em],
  );
  const inserted = await dbQuery(
    `INSERT INTO super_admin_login_challenges
       (user_id, email, code_hash, expires_at, delivery, metadata)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5, $6::jsonb)
     RETURNING id, expires_at`,
    [
      userId,
      em,
      codeHash,
      expiresAt.toISOString(),
      String(delivery || "email").slice(0, 40),
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
  return {
    ok: true,
    challengeId: inserted.rows?.[0]?.id || null,
    expiresAt: inserted.rows?.[0]?.expires_at || expiresAt.toISOString(),
    expiresInSec: Math.floor(CHALLENGE_TTL_MS / 1000),
    /** Plaintext — return only to email sender or recovery script stdout. Never persist. */
    code,
  };
}

async function consumeSuperAdminLoginChallenge(dbQuery, { email, code } = {}) {
  if (typeof dbQuery !== "function") return { ok: false, error: "db_unavailable" };
  const em = normalizeEmail(email);
  const raw = String(code || "").trim().replace(/\s+/g, "");
  if (!isSuperAdminEmail(em) || !/^\d{4,8}$/.test(raw)) {
    return { ok: false, error: "invalid_code" };
  }
  await ensureSuperAdminLoginChallengeTable(dbQuery);
  const codeHash = sha256Hex(`${em}:${raw}`);
  const found = await dbQuery(
    `SELECT id, user_id, expires_at, consumed_at
     FROM super_admin_login_challenges
     WHERE lower(trim(email)) = $1 AND code_hash = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [em, codeHash],
  );
  const row = found.rows?.[0];
  if (!row) return { ok: false, error: "invalid_code" };
  if (row.consumed_at) return { ok: false, error: "code_already_used" };
  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (!exp || Date.now() > exp) {
    await dbQuery(
      `UPDATE super_admin_login_challenges SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1::uuid`,
      [row.id],
    );
    return { ok: false, error: "code_expired" };
  }
  const consumed = await dbQuery(
    `UPDATE super_admin_login_challenges
     SET consumed_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid AND consumed_at IS NULL
     RETURNING id`,
    [row.id],
  );
  if (!consumed.rows?.[0]) return { ok: false, error: "code_already_used" };
  return { ok: true, challengeId: row.id, userId: row.user_id };
}

module.exports = {
  CANONICAL_SUPER_ADMIN_EMAIL,
  CHALLENGE_TTL_MS,
  ensureSuperAdminLoginChallengeTable,
  generateNumericCode,
  isOutageRecoveryEnabled,
  isSuperAdminLoginStepUpEnabled,
  issueSuperAdminLoginChallenge,
  consumeSuperAdminLoginChallenge,
  isSuperAdminEmail,
  normalizeEmail,
};
