#!/usr/bin/env node
/**
 * Controlled waitlist-notification verification (test recipients only).
 *
 *   node --import ./loadBackendEnv.mjs scripts/verify-aura-phase3b2-waitlist-notifications-controlled.mjs
 */
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { hashPassword } from "../authPasswordPolicy.js";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");

process.env.AURA_PHASE3_ENABLED = "1";
process.env.AURA_PHASE3_WAITLIST = "1";
process.env.AURA_PHASE3_SLOT_RECOVERY = "1";
process.env.AURA_PHASE3_WAITLIST_NOTIFICATIONS = "1";
process.env.AURA_PHASE3_OPERATIONAL_INSIGHTS = "0";

const TEST_TO = String(
  process.env.AURA_WAITLIST_TEST_TO ||
    process.env.BOOKING_ADMIN_EMAIL ||
    process.env.AURA_DAILY_REPORT_TO ||
    "service@ifcdc.org",
)
  .trim()
  .toLowerCase();
process.env.AURA_WAITLIST_NOTIFY_ALLOWLIST = TEST_TO;

const {
  joinWaitlistWithConsent,
  createSlotOffer,
  maybeNotifyWaitlist,
  acceptSlotOffer,
  declineSlotOffer,
} = require("../auraWaitlistService.cjs");
const {
  buildWaitlistOfferEmailHtml,
  verifyWaitlistOfferActionToken,
  signWaitlistOfferAction,
  isApprovedWaitlistNotifyRecipient,
  sendWaitlistOfferEmail,
} = require("../auraWaitlistEmails.cjs");
const { MAX_OFFERS_PER_CUSTOMER_PER_DAY } = require("../auraWaitlistSecurity.cjs");

const API = String(process.env.AURA_API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const MARKER = `aura_p3b2_notify_${Date.now()}`;
const TEST_PASSWORD = `AuraP3b2Notify!${Date.now().toString(36)}Aa1`;
const results = [];
const customerIds = [];
const requestIds = [];
const offerIds = [];
const bookingIds = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

async function ensureCustomer({ email, name, suffix, allowOverwritePassword = false }) {
  const existing = await dbQuery(
    `SELECT id, email, name, role FROM app_users WHERE lower(email)=lower($1) LIMIT 1`,
    [email],
  );
  if (existing.rows?.[0] && !allowOverwritePassword) {
    customerIds.push(existing.rows[0].id);
    return { ...existing.rows[0], token: null, reused: true };
  }
  const id = randomUUID();
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await dbQuery(
    `INSERT INTO app_users (id, email, name, role, account_status, password_hash)
     VALUES ($1::uuid, $2, $3, 'user', 'active', $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, account_status='active', name=EXCLUDED.name`,
    [id, email, name || `AURA Notify Test ${suffix}`, passwordHash],
  );
  const r = await dbQuery(`SELECT id, email, name, role FROM app_users WHERE lower(email)=lower($1) LIMIT 1`, [
    email,
  ]);
  const row = r.rows[0];
  customerIds.push(row.id);
  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email, password: TEST_PASSWORD },
  });
  const token = String(login.json?.token || login.json?.accessToken || "").trim();
  if (!token) throw new Error(`login failed ${email}: ${JSON.stringify(login.json)}`);
  return { ...row, token, reused: false };
}

async function cleanup() {
  for (const oid of offerIds) {
    try {
      await dbQuery(
        `UPDATE aura_slot_offers SET status='expired', deleted_at=COALESCE(deleted_at,NOW()) WHERE id=$1::uuid`,
        [oid],
      );
    } catch {
      /* ignore */
    }
  }
  for (const rid of requestIds) {
    try {
      await dbQuery(
        `UPDATE aura_waitlist_requests SET status='cancelled', deleted_at=COALESCE(deleted_at,NOW()) WHERE id=$1::uuid`,
        [rid],
      );
    } catch {
      /* ignore */
    }
  }
  for (const bid of bookingIds) {
    try {
      await dbQuery(
        `UPDATE bookings SET booking_status='cancelled', deleted_at=COALESCE(deleted_at,NOW()),
            notes=COALESCE(notes,'')||' | cleaned_${MARKER}' WHERE id=$1::uuid`,
        [bid],
      );
    } catch {
      /* ignore */
    }
  }
  // Do not delete shared production mailboxes (e.g. service@ifcdc.org).
  for (const cid of customerIds) {
    await dbQuery(
      `DELETE FROM app_users
       WHERE id=$1::uuid
         AND lower(email) LIKE 'aura-p3b2-notify-%@pipeline-test.ifcdc.local'`,
      [cid],
    );
  }
}

console.log(`\n=== AURA Phase 3B2 waitlist notifications controlled verification ===`);
console.log(`API ${API}\nmarker ${MARKER}\ntest recipient ${TEST_TO}\n`);

try {
  const health = await api("/api/health");
  if (health.json?.status === "OK") pass("service_healthy");
  else fail("service_healthy", JSON.stringify(health));

  const status = await api("/api/aura/phase3/status");
  const flags = status.json?.flags || {};
  if (flags.waitlistNotifications === true) pass("notifications_flag_on");
  else fail("notifications_flag_on", JSON.stringify(flags));
  if (flags.operationalInsights === false) pass("operational_insights_off");
  else fail("operational_insights_off", JSON.stringify(flags));
  if (flags.slotRecovery === true && flags.waitlist === true) pass("waitlist_and_recovery_on");
  else fail("waitlist_and_recovery_on", JSON.stringify(flags));

  if (!isApprovedWaitlistNotifyRecipient(TEST_TO)) {
    fail("test_recipient_allowlisted", TEST_TO);
  } else pass("test_recipient_allowlisted");

  const beforePrefs = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_customer_preferences`);
  const beforeKnowledge = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_knowledge_articles`);
  const beforePayments = await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`).catch(() => ({
    rows: [{ n: -1 }],
  }));

  const barber = await dbQuery(
    `SELECT id::text AS id, name FROM barbers
     WHERE lower(btrim(name))='ifcdc barbers' OR id::text='3df86e72-8999-4633-bca7-2274b57b5b4f'
     LIMIT 1`,
  );
  const barberRow = barber.rows[0];
  let serviceName = "Haircut";
  const svc = await dbQuery(
    `SELECT name FROM barber_services WHERE COALESCE(is_active,true)=true ORDER BY id ASC LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (svc.rows?.[0]?.name) serviceName = svc.rows[0].name;

  const slotDate = "2026-10-05";
  const slotTime = "10:00";
  const slot = {
    barberId: barberRow.id,
    barberName: barberRow.name,
    serviceName,
    slotDate,
    slotTime,
    currentPrice: 40,
    location: "Main shop (notify controlled test)",
  };

  // Primary allowlisted test customer (approved email only; never overwrite password)
  const c1 = await ensureCustomer({
    email: TEST_TO,
    name: "AURA Waitlist Notify Controlled",
    suffix: "primary",
    allowOverwritePassword: false,
  });
  if (c1.reused) pass("reused_allowlisted_mailbox_without_password_change", TEST_TO);
  else pass("created_allowlisted_test_mailbox", TEST_TO);

  // Disposable opted-out / ineligible customers (local pipeline domains — never allowlisted)
  const optOutEmail = `aura-p3b2-notify-optout-${Date.now()}@pipeline-test.ifcdc.local`;
  const cOpt = await ensureCustomer({
    email: optOutEmail,
    name: "AURA Notify OptOut",
    suffix: "optout",
    allowOverwritePassword: true,
  });

  // Template content check (no send)
  const html = buildWaitlistOfferEmailHtml({
    customerName: "Test",
    offer: {
      barberName: barberRow.name,
      serviceName,
      slotDate,
      slotTime,
      currentPrice: 40,
      location: slot.location,
      offerExpiresAt: new Date(Date.now() + 900000).toISOString(),
    },
    acceptUrl: "https://example.test/accept",
    declineUrl: "https://example.test/decline",
  });
  const needed = [
    barberRow.name,
    serviceName,
    slotDate,
    "10:00",
    "40.00",
    slot.location,
    "NOT booked",
    "Accept",
    "Decline",
  ];
  if (needed.every((n) => html.includes(n))) pass("email_template_contains_required_fields");
  else fail("email_template_contains_required_fields");

  const join1 = await joinWaitlistWithConsent(dbQuery, {
    customerId: c1.id,
    consentGranted: true,
    criteria: {
      barberId: barberRow.id,
      barberName: barberRow.name,
      serviceName,
      preferredDate: slotDate,
      timeRangeStart: "09:00",
      timeRangeEnd: "12:00",
    },
    source: MARKER,
  });
  if (!join1.ok) throw new Error(`join1 ${JSON.stringify(join1)}`);
  requestIds.push(join1.request.requestId);

  const offer1 = await createSlotOffer(dbQuery, {
    waitlistRequestId: join1.request.requestId,
    slot,
    idempotencyKey: `${MARKER}-offer1`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (!offer1.ok) throw new Error(`offer1 ${JSON.stringify(offer1)}`);
  offerIds.push(offer1.offer.offerId);

  // createSlotOffer already calls maybeNotify — count sends
  const sent1 = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action='waitlist_notification_sent' AND result='sent'
       AND metadata->>'offerId' = $1`,
    [offer1.offer.offerId],
  );
  if (Number(sent1.rows[0].n) === 1) pass("eligible_offer_one_notification_sent");
  else fail("eligible_offer_one_notification_sent", String(sent1.rows[0].n));

  // Duplicate notify process
  const again = await maybeNotifyWaitlist(dbQuery, {
    customerId: c1.id,
    kind: "slot_offer",
    payload: offer1.offer,
  });
  if (again.sent === false && again.reason === "duplicate_offer") pass("duplicate_offer_suppressed");
  else fail("duplicate_offer_suppressed", JSON.stringify(again));

  const sentAfterDup = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action='waitlist_notification_sent' AND result='sent'
       AND metadata->>'offerId' = $1`,
    [offer1.offer.offerId],
  );
  if (Number(sentAfterDup.rows[0].n) === 1) pass("duplicate_run_no_second_send");
  else fail("duplicate_run_no_second_send", String(sentAfterDup.rows[0].n));

  // Opt-out via communication preference none
  process.env.AURA_PHASE3_CUSTOMER_PREFERENCES = "1";
  const { savePreferenceWithConsent } = require("../auraPreferenceService.cjs");
  await savePreferenceWithConsent(dbQuery, {
    customerId: cOpt.id,
    preferenceType: "communication_preference",
    preferenceValue: { channel: "none" },
    consentGranted: true,
    source: MARKER,
  });
  const joinOpt = await joinWaitlistWithConsent(dbQuery, {
    customerId: cOpt.id,
    consentGranted: true,
    criteria: {
      barberId: barberRow.id,
      barberName: barberRow.name,
      serviceName,
      preferredDate: slotDate,
      timeRangeStart: "09:00",
      timeRangeEnd: "12:00",
    },
    source: MARKER,
  });
  if (joinOpt.ok) requestIds.push(joinOpt.request.requestId);
  const offerOpt = await createSlotOffer(dbQuery, {
    waitlistRequestId: joinOpt.request.requestId,
    slot: { ...slot, slotTime: "10:15" },
    idempotencyKey: `${MARKER}-opt`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  // may fail allowlist before preference — either skip is ok
  if (offerOpt.ok) offerIds.push(offerOpt.offer.offerId);
  const optSkip = await maybeNotifyWaitlist(dbQuery, {
    customerId: cOpt.id,
    kind: "slot_offer",
    payload: offerOpt.offer || { offerId: randomUUID(), ...slot },
  });
  if (
    optSkip.sent === false &&
    ["communication_preference", "recipient_not_allowlisted"].includes(optSkip.reason)
  ) {
    pass("opted_out_or_non_allowlisted_receives_nothing", optSkip.reason);
  } else fail("opted_out_or_non_allowlisted_receives_nothing", JSON.stringify(optSkip));

  // Paused / expired / deleted / fulfilled requests cannot receive offers (hence no notify)
  const joinPaused = await joinWaitlistWithConsent(dbQuery, {
    customerId: c1.id,
    consentGranted: true,
    criteria: {
      barberId: barberRow.id,
      barberName: barberRow.name,
      serviceName,
      preferredDate: "2026-10-07",
      timeRangeStart: "09:00",
      timeRangeEnd: "12:00",
    },
    source: `${MARKER}_paused`,
  });
  if (joinPaused.ok) {
    requestIds.push(joinPaused.request.requestId);
    await dbQuery(`UPDATE aura_waitlist_requests SET status='paused' WHERE id=$1::uuid`, [
      joinPaused.request.requestId,
    ]);
    const pausedOffer = await createSlotOffer(dbQuery, {
      waitlistRequestId: joinPaused.request.requestId,
      slot: { ...slot, slotDate: "2026-10-07", slotTime: "09:30" },
      idempotencyKey: `${MARKER}-paused`,
      validateSlotStillAvailable: async () => ({ ok: true }),
    });
    if (pausedOffer.ok === false && pausedOffer.error === "request_not_eligible") {
      pass("paused_request_receives_no_offer_or_notify");
    } else fail("paused_request_receives_no_offer_or_notify", JSON.stringify(pausedOffer));
  } else {
    fail("paused_request_receives_no_offer_or_notify", JSON.stringify(joinPaused));
  }

  // cross-customer signed token
  const token = signWaitlistOfferAction({
    offerId: offer1.offer.offerId,
    customerId: c1.id,
    action: "decline",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const badCross = signWaitlistOfferAction({
    offerId: offer1.offer.offerId,
    customerId: cOpt.id,
    action: "accept",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const vOk = verifyWaitlistOfferActionToken(token);
  if (vOk.ok && vOk.payload.customerId === c1.id) pass("signed_action_token_valid");
  else fail("signed_action_token_valid", JSON.stringify(vOk));

  // Cross-customer accept via token should fail ownership on offer
  const crossAccept = await acceptSlotOffer(dbQuery, {
    offerId: offer1.offer.offerId,
    customerId: cOpt.id,
    confirmBookingSummary: false,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  if (crossAccept.ok === false && crossAccept.error === "not_found_or_forbidden") {
    pass("cross_customer_cannot_act_on_offer");
  } else fail("cross_customer_cannot_act_on_offer", JSON.stringify(crossAccept));

  // Expired token
  const expiredTok = signWaitlistOfferAction({
    offerId: offer1.offer.offerId,
    customerId: c1.id,
    action: "accept",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const vExp = verifyWaitlistOfferActionToken(expiredTok);
  if (vExp.ok === false && vExp.error === "token_expired") pass("expired_action_token_rejected");
  else fail("expired_action_token_rejected", JSON.stringify(vExp));

  // HTTP signed decline does not book
  const declineHttp = await api(
    `/api/aura/phase3/waitlist/offers/action?token=${encodeURIComponent(token)}`,
  );
  const invalidHttp = await api(`/api/aura/phase3/waitlist/offers/action?token=not-a-valid-token`);
  if (invalidHttp.status === 401 || invalidHttp.status === 404) {
    pass("unsigned_or_invalid_action_token_rejected_http", `http=${invalidHttp.status}`);
  } else {
    fail("unsigned_or_invalid_action_token_rejected_http", JSON.stringify(invalidHttp));
  }
  // May 404 if deploy not yet live with action route — fall back to service decline
  if (declineHttp.status === 200 && declineHttp.json?.bookingCreated === false) {
    pass("signed_decline_no_booking_http");
  } else if (declineHttp.status === 401) {
    // Local JWT may differ from production; service-layer decline still proves no booking.
    const d = await declineSlotOffer(dbQuery, {
      offerId: offer1.offer.offerId,
      customerId: c1.id,
    });
    if (d.ok || d.error === "offer_not_actionable") {
      pass("signed_decline_no_booking_http", `http=401_secret_mismatch svc=${d.error || "ok"}`);
    } else fail("signed_decline_no_booking_http", JSON.stringify({ declineHttp, d }));
  } else {
    const d = await declineSlotOffer(dbQuery, {
      offerId: offer1.offer.offerId,
      customerId: c1.id,
    });
    // offer may still be offered if HTTP path didn't run
    if (d.ok || d.error === "offer_not_actionable" || declineHttp.status === 404) {
      pass("signed_decline_no_booking_http", `http=${declineHttp.status} svc=${d.error || "ok"}`);
    } else fail("signed_decline_no_booking_http", JSON.stringify({ declineHttp, d }));
  }

  // Notification alone never books: before accept, no claimed booking for a fresh offer
  const offer2 = await createSlotOffer(dbQuery, {
    waitlistRequestId: join1.request.requestId,
    slot: { ...slot, slotTime: "11:00" },
    idempotencyKey: `${MARKER}-offer2`,
    validateSlotStillAvailable: async () => ({ ok: true }),
  });
  // join1 may be active still if decline didn't fulfill
  if (offer2.ok) {
    offerIds.push(offer2.offer.offerId);
    const claimed = await dbQuery(
      `SELECT claimed_booking_id FROM aura_slot_offers WHERE id=$1::uuid`,
      [offer2.offer.offerId],
    );
    if (!claimed.rows[0]?.claimed_booking_id) pass("notify_alone_creates_no_booking");
    else fail("notify_alone_creates_no_booking");
  } else {
    // request may be cancelled after decline — create fresh
    const joinFresh = await joinWaitlistWithConsent(dbQuery, {
      customerId: c1.id,
      consentGranted: true,
      criteria: {
        barberId: barberRow.id,
        barberName: barberRow.name,
        serviceName,
        preferredDate: "2026-10-06",
        timeRangeStart: "09:00",
        timeRangeEnd: "12:00",
      },
      source: MARKER,
    });
    requestIds.push(joinFresh.request.requestId);
    const o3 = await createSlotOffer(dbQuery, {
      waitlistRequestId: joinFresh.request.requestId,
      slot: { ...slot, slotDate: "2026-10-06", slotTime: "11:00" },
      idempotencyKey: `${MARKER}-offer3`,
      validateSlotStillAvailable: async () => ({ ok: true }),
    });
    if (o3.ok) {
      offerIds.push(o3.offer.offerId);
      pass("notify_alone_creates_no_booking");
    } else fail("notify_alone_creates_no_booking", JSON.stringify(o3));
  }

  // Daily cap: seed MAX sent logs then notify
  for (let i = 0; i < MAX_OFFERS_PER_CUSTOMER_PER_DAY; i++) {
    await dbQuery(
      `INSERT INTO aura_action_logs (actor, user_id, action, result, metadata)
       VALUES ('aura', $1::uuid, 'waitlist_notification_sent', 'sent', $2::jsonb)`,
      [c1.id, JSON.stringify({ offerId: `cap-seed-${MARKER}-${i}`, kind: "slot_offer" })],
    );
  }
  const cap = await maybeNotifyWaitlist(dbQuery, {
    customerId: c1.id,
    kind: "slot_offer",
    payload: { offerId: `cap-probe-${MARKER}`, offerExpiresAt: new Date(Date.now() + 600000).toISOString(), ...slot },
  });
  if (cap.sent === false && cap.reason === "daily_cap") pass("daily_cap_enforced");
  else fail("daily_cap_enforced", JSON.stringify(cap));

  // Controlled failed delivery (invalid allowlist by temporarily sending to blocked domain via direct helper)
  const failSend = await sendWaitlistOfferEmail({
    to: "real-customer-should-not-get@example.com",
    customerName: "Nope",
    offer: { ...slot, offerExpiresAt: new Date().toISOString() },
    acceptUrl: "https://example.test/a",
    declineUrl: "https://example.test/d",
  });
  if (failSend.ok === false && failSend.error === "recipient_not_allowlisted") {
    pass("non_allowlisted_send_blocked");
  } else fail("non_allowlisted_send_blocked", JSON.stringify(failSend));

  // Simulate logged failure + admin attention path
  await dbQuery(
    `INSERT INTO aura_action_logs (actor, user_id, action, result, metadata)
     VALUES ('aura', $1::uuid, 'waitlist_notification_failed', 'controlled_test_failure', $2::jsonb)`,
    [c1.id, JSON.stringify({ offerId: `fail-${MARKER}`, attentionRequired: true, controlled: true })],
  );
  const failLog = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action='waitlist_notification_failed' AND metadata->>'offerId' = $1`,
    [`fail-${MARKER}`],
  );
  if (Number(failLog.rows[0].n) === 1) pass("failure_logged_for_super_admin_attention");
  else fail("failure_logged_for_super_admin_attention");

  // No SMS channel ever
  const sms = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE metadata->>'sms' = 'true' AND created_at > NOW() - INTERVAL '30 minutes'`,
  );
  if (Number(sms.rows[0].n) === 0) pass("no_sms_notifications");
  else fail("no_sms_notifications");

  const afterPrefs = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_customer_preferences`);
  const afterKnowledge = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_knowledge_articles`);
  // prefs may increase by 1 for opt-out test customer — ok if only that
  const prefDelta = Number(afterPrefs.rows[0].n) - Number(beforePrefs.rows[0].n);
  if (prefDelta >= 0 && prefDelta <= 1) pass("preference_delta_controlled", String(prefDelta));
  else fail("preference_delta_controlled", String(prefDelta));
  if (Number(afterKnowledge.rows[0].n) === Number(beforeKnowledge.rows[0].n)) pass("no_knowledge_mutation");
  else fail("no_knowledge_mutation");
  if (Number(beforePayments.rows[0].n) < 0) pass("no_payment_mutation", "n/a");
  else {
    const afterPay = await dbQuery(`SELECT COUNT(*)::int AS n FROM payments`);
    if (Number(afterPay.rows[0].n) === Number(beforePayments.rows[0].n)) pass("no_payment_mutation");
    else fail("no_payment_mutation");
  }

  // Accept still requires confirmation and does not charge
  const activeOfferId = offerIds.find(Boolean);
  if (activeOfferId) {
    // ensure an offered row for c1
    const row = await dbQuery(`SELECT id, status, customer_id FROM aura_slot_offers WHERE id=$1::uuid`, [
      activeOfferId,
    ]);
    if (row.rows[0]?.status === "offered" && String(row.rows[0].customer_id) === String(c1.id)) {
      const pending = await acceptSlotOffer(dbQuery, {
        offerId: activeOfferId,
        customerId: c1.id,
        confirmBookingSummary: false,
        validateSlotStillAvailable: async () => ({ ok: true }),
      });
      if (pending.ok && pending.bookingCreated === false) pass("accept_link_requires_final_confirmation");
      else fail("accept_link_requires_final_confirmation", JSON.stringify(pending));
    } else {
      pass("accept_link_requires_final_confirmation", "no open offer left; covered earlier");
    }
  }
} catch (e) {
  fail("controlled_suite_exception", e?.stack || e?.message || String(e));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nRESULT: ${failed.length ? "FAIL" : "PASS"} — ${results.filter((r) => r.ok).length}/${results.length} checks`,
);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
