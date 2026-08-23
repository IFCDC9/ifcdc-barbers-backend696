#!/usr/bin/env node
/**
 * Live Super Admin SMS login probe — does NOT require password.
 * Resolves phone from app_users (service@ifcdc.org), then Twilio Verify channel=sms.
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

const CANONICAL = String(
  process.env.CANONICAL_SUPER_ADMIN_EMAIL || "service@ifcdc.org",
)
  .trim()
  .toLowerCase();

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

async function main() {
  process.env.SMS_VERIFY_ENABLED = process.env.SMS_VERIFY_ENABLED || "1";
  await resolveVerifySidIfNeeded();

  console.log("[sa-sms] twilio", twilioConfigStatus());
  if (!isTwilioVerifyConfigured()) {
    throw new Error("Twilio Verify is not configured after SID resolve");
  }

  const found = await dbQuery(
    `SELECT id, email, role, phone, phone_e164
     FROM app_users
     WHERE lower(trim(email::text)) = $1
     LIMIT 1`,
    [CANONICAL],
  );
  const user = found.rows?.[0];
  if (!user) throw new Error(`Super Admin user not found: ${CANONICAL}`);

  const envPhone = String(process.env.SUPER_ADMIN_SMS_PHONE || "").trim();
  const candidates = [user.phone_e164, user.phone, envPhone];
  let phone = null;
  for (const raw of candidates) {
    const n = normalizeToE164(String(raw || "").trim());
    if (n.ok) {
      phone = n.e164;
      break;
    }
  }
  if (!phone) throw new Error("No E.164 Super Admin phone on account or SUPER_ADMIN_SMS_PHONE");

  console.log("[sa-sms] targeting", {
    email: user.email,
    role: user.role,
    toMasked: maskPhoneForDisplay(phone),
    source: user.phone_e164 || user.phone ? "app_users" : "SUPER_ADMIN_SMS_PHONE",
    channel: "sms",
  });

  const started = await startSmsVerification(dbQuery, {
    phone,
    purpose: "super_admin_login",
    actorUserId: user.id,
    ipText: "verify-super-admin-sms-login",
  });

  console.log(
    JSON.stringify(
      {
        ok: started.ok === true,
        channel: "sms",
        toMasked: started.toMasked || maskPhoneForDisplay(phone),
        twilioSid: started.sid || started.twilioSid || null,
        status: started.status || null,
        error: started.error || null,
        message: started.message || null,
      },
      null,
      2,
    ),
  );

  if (!started.ok || !(started.sid || started.twilioSid)) {
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("[sa-sms] EXCEPTION", e?.message || e);
  process.exit(1);
});
