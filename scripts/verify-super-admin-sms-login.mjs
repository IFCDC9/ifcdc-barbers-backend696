#!/usr/bin/env node
/**
 * Live Super Admin SMS login probe — sends Twilio Verify to +18484694448 only.
 *
 *   CONFIRM_LIVE_SMS=1 node --import ./loadBackendEnv.mjs scripts/verify-super-admin-sms-login.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const { startSmsVerification } = require("../smsVerifyService.cjs");
const { normalizeToE164, maskPhoneForDisplay } = require("../smsPhone.cjs");
const {
  getTwilioClient,
  getTwilioVerifyServiceSid,
  isTwilioAccountConfigured,
  isTwilioVerifyConfigured,
  twilioConfigStatus,
} = require("../smsTwilioClient.cjs");

const CANONICAL = "service@ifcdc.org";
const REQUIRED_TO = "+18484694448";

if (process.env.CONFIRM_LIVE_SMS !== "1") {
  console.error("Refusing: set CONFIRM_LIVE_SMS=1 to send a live Super Admin Verify SMS.");
  process.exit(2);
}

async function resolveVerifySidIfNeeded() {
  if (getTwilioVerifyServiceSid()) return;
  if (!isTwilioAccountConfigured()) return;
  const client = getTwilioClient();
  const services = await client.verify.v2.services.list({ limit: 8 });
  const match =
    services.find((s) => /AURA|IFCDC|Verification|Verify/i.test(String(s.friendlyName || ""))) ||
    services[0];
  if (match?.sid) {
    process.env.TWILIO_VERIFY_SERVICE_SID = match.sid;
    console.log("[sa-sms] resolved TWILIO_VERIFY_SERVICE_SID prefix:", `${match.sid.slice(0, 4)}…`);
  }
}

async function syncAccountPhone() {
  await dbQuery(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone_e164 TEXT`).catch(() => {});
  const upd = await dbQuery(
    `UPDATE app_users
     SET phone = $2, phone_e164 = $3
     WHERE lower(trim(email::text)) = $1
     RETURNING email, phone, phone_e164`,
    [CANONICAL, "8484694448", REQUIRED_TO],
  );
  console.log("[sa-sms] app_users phone synced", upd.rows?.[0] || null);
}

async function main() {
  process.env.SMS_VERIFY_ENABLED = process.env.SMS_VERIFY_ENABLED || "1";
  await resolveVerifySidIfNeeded();
  await syncAccountPhone();

  console.log("[sa-sms] twilio", twilioConfigStatus());
  if (!isTwilioVerifyConfigured()) {
    throw new Error("Twilio Verify is not configured after SID resolve");
  }

  const to = normalizeToE164(REQUIRED_TO);
  if (!to.ok || to.e164 !== REQUIRED_TO) {
    throw new Error(`Required To must be ${REQUIRED_TO}`);
  }

  const found = await dbQuery(
    `SELECT id, email, role, phone, phone_e164 FROM app_users WHERE lower(trim(email::text)) = $1 LIMIT 1`,
    [CANONICAL],
  );
  const user = found.rows?.[0];
  if (!user) throw new Error(`Super Admin user not found: ${CANONICAL}`);

  console.log("[sa-sms] targeting", {
    email: user.email,
    role: user.role,
    to: REQUIRED_TO,
    toMasked: maskPhoneForDisplay(REQUIRED_TO),
    channel: "sms",
    accountPhone: user.phone || null,
    accountPhoneE164: user.phone_e164 || null,
  });

  const started = await startSmsVerification(dbQuery, {
    phone: REQUIRED_TO,
    purpose: "super_admin_login",
    actorUserId: user.id,
    ipText: "verify-super-admin-sms-login",
  });

  const report = {
    ok: started.ok === true,
    channel: "sms",
    to: REQUIRED_TO,
    toMasked: started.toMasked || maskPhoneForDisplay(REQUIRED_TO),
    twilioSid: started.sid || started.twilioSid || null,
    status: started.status || null,
    error: started.error || null,
    message: started.message || null,
  };
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok || !report.twilioSid || report.to !== REQUIRED_TO) {
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("[sa-sms] EXCEPTION", e?.message || e);
  process.exit(1);
});
