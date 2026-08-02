#!/usr/bin/env node
/**
 * Controlled production waitlist-only verification (slot recovery + notifications stay OFF).
 * Creates disposable test customers, exercises waitlist APIs, soft-deletes requests, cleans users.
 *
 *   node --import ./loadBackendEnv.mjs scripts/verify-aura-phase3b2-waitlist-controlled.mjs
 */
import { createRequire } from "module";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

const require = createRequire(import.meta.url);
const { dbQuery } = require("../db.js");
const { jwtClaimsFromAppUser } = require("../authPlatformJwt.js");

const API = String(process.env.AURA_API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/$/,
  "",
);
const JWT_SECRET = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || "").trim();
const ADMIN_KEY = String(process.env.ADMIN_SECRET || "").trim();
const MARKER = `aura_p3b2_waitlist_${Date.now()}`;
const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, { method = "GET", token, adminKey, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
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
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

function mintToken(userRow) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET required to mint test customer tokens");
  const claims = jwtClaimsFromAppUser(userRow);
  return jwt.sign(claims, JWT_SECRET, { expiresIn: "2h" });
}

async function ensureTestCustomer(suffix) {
  const id = randomUUID();
  const email = `aura-p3b2-waitlist-${suffix}-${Date.now()}@pipeline-test.ifcdc.local`;
  await dbQuery(
    `INSERT INTO app_users (id, email, name, role, account_status, password_hash)
     VALUES ($1::uuid, $2, $3, 'user', 'active', '!' )
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, role, name`,
    [id, email, `AURA P3B2 Waitlist Test ${suffix}`],
  );
  const r = await dbQuery(
    `SELECT id, email, role, name FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  const row = r.rows?.[0];
  if (!row) throw new Error(`failed to create test customer ${email}`);
  return { ...row, marker: MARKER, email };
}

async function cleanup(customerIds, requestIds) {
  for (const rid of requestIds) {
    try {
      await dbQuery(
        `UPDATE aura_waitlist_requests
         SET status = 'cancelled', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
         WHERE id = $1::uuid`,
        [rid],
      );
    } catch {
      /* tables may not exist on early fail */
    }
  }
  for (const cid of customerIds) {
    await dbQuery(`DELETE FROM app_users WHERE id = $1::uuid AND lower(email) LIKE 'aura-p3b2-waitlist-%@pipeline-test.ifcdc.local'`, [
      cid,
    ]);
  }
}

console.log(`\n=== AURA Phase 3B2 waitlist-only controlled verification ===\nAPI ${API}\nmarker ${MARKER}\n`);

const health = await api("/api/health");
if (health.status === 200 && health.json?.status === "OK") pass("service_healthy");
else fail("service_healthy", JSON.stringify(health));

const status = await api("/api/aura/phase3/status");
const flags = status.json?.flags || {};
if (flags.waitlist === true) pass("waitlist_flag_on");
else fail("waitlist_flag_on", JSON.stringify(flags));
if (flags.slotRecovery === false) pass("slot_recovery_off");
else fail("slot_recovery_off", JSON.stringify(flags));
if (flags.waitlistNotifications === false) pass("notifications_off");
else fail("notifications_off", JSON.stringify(flags));
if (flags.operationalInsights === false) pass("operational_insights_off");
else fail("operational_insights_off", JSON.stringify(flags));

const wlStatus = await api("/api/aura/phase3/waitlist/status");
if (wlStatus.json?.waitlistEnabled === true && wlStatus.json?.slotRecoveryEnabled === false) {
  pass("waitlist_status_endpoint");
} else fail("waitlist_status_endpoint", JSON.stringify(wlStatus.json));

// Auth gates
const unauthMe = await api("/api/aura/phase3/waitlist/me");
if (unauthMe.status === 401 || unauthMe.status === 403) pass("waitlist_me_requires_auth", `HTTP ${unauthMe.status}`);
else fail("waitlist_me_requires_auth", `HTTP ${unauthMe.status} ${JSON.stringify(unauthMe.json)}`);

const unauthJoin = await api("/api/aura/phase3/waitlist", { method: "POST", body: { consentGranted: true } });
if (unauthJoin.status === 401 || unauthJoin.status === 403) pass("waitlist_join_requires_auth", `HTTP ${unauthJoin.status}`);
else fail("waitlist_join_requires_auth", `HTTP ${unauthJoin.status}`);

const unauthMigrate = await api("/api/aura/phase3/admin/waitlist/migrate", { method: "POST", body: {} });
if (unauthMigrate.status === 401 || unauthMigrate.status === 403) {
  pass("admin_migrate_requires_auth", `HTTP ${unauthMigrate.status}`);
} else fail("admin_migrate_requires_auth", `HTTP ${unauthMigrate.status} ${JSON.stringify(unauthMigrate.json)}`);

const offerDisabled = await api("/api/aura/phase3/waitlist/offers/me");
if (
  offerDisabled.status === 404 &&
  offerDisabled.json?.error === "aura_phase3_slot_recovery_disabled"
) {
  pass("offers_disabled_while_recovery_off");
} else fail("offers_disabled_while_recovery_off", JSON.stringify(offerDisabled));

// Baseline counts before mutation
const before = await dbQuery(`
  SELECT
    (SELECT COUNT(*)::int FROM bookings) AS bookings,
    (SELECT COUNT(*)::int FROM aura_customer_preferences) AS prefs,
    (SELECT COUNT(*)::int FROM aura_knowledge_articles) AS knowledge,
    (SELECT COUNT(*)::int FROM information_schema.tables
      WHERE table_schema='public' AND table_name='aura_waitlist_requests') AS waitlist_exists
`);
const beforeRow = before.rows[0];

// Migration via boot should have created tables; ensure via admin if needed
let tables = await dbQuery(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public'
    AND table_name IN ('aura_waitlist_requests','aura_waitlist_events','aura_slot_offers','aura_slot_offer_events')
  ORDER BY 1
`);
if (tables.rows.length < 4 && ADMIN_KEY) {
  const mig = await api("/api/aura/phase3/admin/waitlist/migrate", { method: "POST", adminKey: ADMIN_KEY, body: {} });
  if (mig.status === 200 && mig.json?.ok) pass("admin_migrate_super_admin_key");
  else fail("admin_migrate_super_admin_key", `HTTP ${mig.status} ${JSON.stringify(mig.json)}`);
  tables = await dbQuery(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND table_name IN ('aura_waitlist_requests','aura_waitlist_events','aura_slot_offers','aura_slot_offer_events')
    ORDER BY 1
  `);
}

if (tables.rows.length === 4) pass("waitlist_tables_present", tables.rows.map((r) => r.table_name).join(","));
else fail("waitlist_tables_present", JSON.stringify(tables.rows));

const indexes = await dbQuery(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname='public'
    AND tablename IN ('aura_waitlist_requests','aura_waitlist_events','aura_slot_offers','aura_slot_offer_events')
  ORDER BY indexname
`);
const needed = [
  "aura_waitlist_requests_customer_idx",
  "aura_waitlist_requests_active_idx",
  "aura_waitlist_requests_active_dup_uniq",
  "aura_waitlist_events_customer_idx",
  "aura_slot_offers_customer_idx",
  "aura_slot_offers_open_slot_uniq",
  "aura_slot_offer_events_offer_idx",
];
const have = new Set(indexes.rows.map((r) => r.indexname));
const missingIdx = needed.filter((n) => !have.has(n));
if (missingIdx.length === 0) pass("waitlist_indexes_present", `${needed.length} required`);
else fail("waitlist_indexes_present", `missing ${missingIdx.join(",")}`);

const customerIds = [];
const requestIds = [];
try {
  const c1 = await ensureTestCustomer("a");
  const c2 = await ensureTestCustomer("b");
  customerIds.push(c1.id, c2.id);
  const t1 = mintToken(c1);
  const t2 = mintToken(c2);

  const empty = await api("/api/aura/phase3/waitlist/me", { token: t1 });
  if (empty.status === 200 && Array.isArray(empty.json?.requests) && empty.json.requests.length === 0) {
    pass("view_empty_waitlist");
  } else fail("view_empty_waitlist", JSON.stringify(empty));

  const decline = await api("/api/aura/phase3/waitlist/consent/decline", { method: "POST", token: t1, body: {} });
  if (decline.status === 200 && decline.json?.saved === false) pass("decline_consent_nothing_saved");
  else fail("decline_consent_nothing_saved", JSON.stringify(decline));

  const afterDecline = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_waitlist_requests WHERE customer_id = $1::uuid`,
    [c1.id],
  );
  if (Number(afterDecline.rows[0].n) === 0) pass("decline_no_request_row");
  else fail("decline_no_request_row", String(afterDecline.rows[0].n));

  const barber = await dbQuery(
    `SELECT id::text AS id, name FROM barbers
     WHERE lower(btrim(name)) = 'ifcdc barbers' OR id::text = '3df86e72-8999-4633-bca7-2274b57b5b4f'
     LIMIT 1`,
  );
  const barberRow = barber.rows?.[0];
  if (!barberRow) throw new Error("IFCDC Barbers not found for controlled criteria");

  let serviceName = "Haircut";
  const svc = await dbQuery(
    `SELECT name FROM barber_services WHERE COALESCE(is_active,true)=true ORDER BY id ASC LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (svc.rows?.[0]?.name) serviceName = svc.rows[0].name;
  else {
    const st = await dbQuery(`SELECT title AS name FROM styles ORDER BY created_at DESC LIMIT 1`).catch(() => ({
      rows: [],
    }));
    if (st.rows?.[0]?.name) serviceName = st.rows[0].name;
  }

  const criteria = {
    barberId: barberRow.id,
    barberName: barberRow.name,
    serviceName,
    dateFrom: "2026-08-20",
    dateTo: "2026-08-27",
    timeRangeStart: "09:00",
    timeRangeEnd: "12:00",
  };

  const joinBlocked = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t1,
    body: { consentGranted: false, criteria },
  });
  if (joinBlocked.status === 403 && joinBlocked.json?.error === "consent_required") {
    pass("join_requires_consent");
  } else fail("join_requires_consent", JSON.stringify(joinBlocked));

  const joined = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t1,
    body: { consentGranted: true, criteria, source: MARKER },
  });
  if (joined.status === 200 && joined.json?.ok && joined.json?.createsBooking === false && joined.json?.chargesPayment === false) {
    pass("join_waitlist_no_book_no_charge");
    requestIds.push(joined.json.request.requestId);
  } else fail("join_waitlist_no_book_no_charge", JSON.stringify(joined));

  const view = await api(`/api/aura/phase3/waitlist/me/${joined.json?.request?.requestId}`, { token: t1 });
  if (view.status === 200 && view.json?.request?.requestId === joined.json.request.requestId) pass("view_own_request");
  else fail("view_own_request", JSON.stringify(view));

  const updated = await api(`/api/aura/phase3/waitlist/me/${joined.json.request.requestId}`, {
    method: "PATCH",
    token: t1,
    body: {
      criteria: { ...criteria, timeRangeStart: "10:00", timeRangeEnd: "13:00" },
    },
  });
  if (updated.status === 200 && updated.json?.ok) pass("update_request");
  else fail("update_request", JSON.stringify(updated));

  const paused = await api(`/api/aura/phase3/waitlist/me/${joined.json.request.requestId}`, {
    method: "PATCH",
    token: t1,
    body: { status: "paused" },
  });
  if (paused.status === 200 && paused.json?.request?.status === "paused") pass("pause_request");
  else fail("pause_request", JSON.stringify(paused));

  const resumed = await api(`/api/aura/phase3/waitlist/me/${joined.json.request.requestId}`, {
    method: "PATCH",
    token: t1,
    body: { status: "active" },
  });
  if (resumed.status === 200 && resumed.json?.request?.status === "active") pass("resume_request");
  else fail("resume_request", JSON.stringify(resumed));

  const dup = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t1,
    body: {
      consentGranted: true,
      criteria: { ...criteria, timeRangeStart: "10:00", timeRangeEnd: "13:00" },
      source: MARKER,
    },
  });
  if (dup.status === 200 && dup.json?.request?.requestId === joined.json.request.requestId) {
    pass("duplicate_merged_or_same_request");
  } else if (dup.status === 200 && dup.json?.ok) {
    pass("duplicate_handled", `id=${dup.json.request?.requestId}`);
    if (dup.json.request?.requestId) requestIds.push(dup.json.request.requestId);
  } else fail("duplicate_prevention", JSON.stringify(dup));

  const cross = await api(`/api/aura/phase3/waitlist/me/${joined.json.request.requestId}`, { token: t2 });
  if (cross.status === 404 && cross.json?.error === "not_found_or_forbidden") pass("cross_customer_rejected");
  else fail("cross_customer_rejected", JSON.stringify(cross));

  const badBarber = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t2,
    body: {
      consentGranted: true,
      criteria: {
        barberName: "Definitely Not A Real Barber 999",
        serviceName,
        dateFrom: "2026-08-20",
        dateTo: "2026-08-27",
        timeRangeStart: "09:00",
        timeRangeEnd: "12:00",
      },
    },
  });
  if (badBarber.status === 400 && badBarber.json?.error === "unauthorized_barber") pass("invalid_barber_rejected");
  else fail("invalid_barber_rejected", JSON.stringify(badBarber));

  const badService = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t2,
    body: {
      consentGranted: true,
      criteria: {
        barberId: barberRow.id,
        barberName: barberRow.name,
        serviceName: "Definitely Not A Real Service 999",
        dateFrom: "2026-08-20",
        dateTo: "2026-08-27",
        timeRangeStart: "09:00",
        timeRangeEnd: "12:00",
      },
    },
  });
  if (badService.status === 400 && badService.json?.error === "unauthorized_service") pass("invalid_service_rejected");
  else fail("invalid_service_rejected", JSON.stringify(badService));

  // Expired exclusion via direct DB status (match scanner only when slot recovery on)
  const expiredJoin = await api("/api/aura/phase3/waitlist", {
    method: "POST",
    token: t2,
    body: {
      consentGranted: true,
      criteria: {
        ...criteria,
        preferredDate: "2026-09-01",
        dateFrom: null,
        dateTo: null,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      source: MARKER,
    },
  });
  if (expiredJoin.json?.request?.requestId) {
    requestIds.push(expiredJoin.json.request.requestId);
    await dbQuery(`UPDATE aura_waitlist_requests SET status='expired' WHERE id=$1::uuid`, [
      expiredJoin.json.request.requestId,
    ]);
    const list2 = await api("/api/aura/phase3/waitlist/me", { token: t2 });
    const activeOnly = (list2.json?.requests || []).filter((r) => r.status === "active");
    if (!activeOnly.some((r) => r.requestId === expiredJoin.json.request.requestId)) {
      pass("expired_request_not_active");
    } else fail("expired_request_not_active");
  } else fail("expired_request_setup", JSON.stringify(expiredJoin));

  const removed = await api(`/api/aura/phase3/waitlist/me/${joined.json.request.requestId}`, {
    method: "DELETE",
    token: t1,
  });
  if (removed.status === 200 && removed.json?.ok) pass("soft_delete_remove");
  else fail("soft_delete_remove", JSON.stringify(removed));

  const soft = await dbQuery(
    `SELECT status, deleted_at IS NOT NULL AS soft_deleted
     FROM aura_waitlist_requests WHERE id = $1::uuid`,
    [joined.json.request.requestId],
  );
  if (soft.rows[0]?.soft_deleted || soft.rows[0]?.status === "cancelled") pass("soft_delete_preserved_row");
  else fail("soft_delete_preserved_row", JSON.stringify(soft.rows[0]));

  const events = await dbQuery(
    `SELECT event_type FROM aura_waitlist_events WHERE customer_id = $1::uuid ORDER BY created_at ASC`,
    [c1.id],
  );
  const types = events.rows.map((r) => r.event_type);
  if (types.includes("consent_declined") && (types.includes("request_created") || types.includes("request_merged"))) {
    pass("waitlist_events_audit", types.join(","));
  } else fail("waitlist_events_audit", types.join(",") || "(none)");

  const actions = await dbQuery(
    `SELECT action FROM aura_action_logs
     WHERE user_id = $1::uuid AND action LIKE 'waitlist_%'
     ORDER BY created_at ASC`,
    [c1.id],
  );
  const acts = actions.rows.map((r) => r.action);
  if (acts.includes("waitlist_consent_decline") && acts.some((a) => a.includes("waitlist_request"))) {
    pass("aura_action_logs_waitlist", acts.join(","));
  } else fail("aura_action_logs_waitlist", acts.join(",") || "(none)");

  const bookingsDelta = await dbQuery(`SELECT COUNT(*)::int AS n FROM bookings`);
  const prefsDelta = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_customer_preferences`);
  const knowledgeDelta = await dbQuery(`SELECT COUNT(*)::int AS n FROM aura_knowledge_articles`);
  if (Number(bookingsDelta.rows[0].n) === Number(beforeRow.bookings)) pass("no_booking_count_change");
  else fail("no_booking_count_change", `${beforeRow.bookings} -> ${bookingsDelta.rows[0].n}`);
  if (Number(prefsDelta.rows[0].n) === Number(beforeRow.prefs)) pass("no_preference_count_change");
  else fail("no_preference_count_change");
  if (Number(knowledgeDelta.rows[0].n) === Number(beforeRow.knowledge)) pass("no_knowledge_count_change");
  else fail("no_knowledge_count_change");

  const offerCreate = await api("/api/aura/phase3/admin/waitlist/offers", {
    method: "POST",
    adminKey: ADMIN_KEY || "x",
    body: { waitlistRequestId: joined.json.request.requestId, slot: { slotDate: "2026-08-20", slotTime: "10:00" } },
  });
  if (offerCreate.status === 404 && offerCreate.json?.error === "aura_phase3_slot_recovery_disabled") {
    pass("no_slot_offer_while_recovery_off");
  } else fail("no_slot_offer_while_recovery_off", JSON.stringify(offerCreate));

  const notifCheck = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM aura_action_logs
     WHERE action LIKE 'waitlist_notification%' AND created_at > NOW() - INTERVAL '30 minutes'`,
  );
  if (Number(notifCheck.rows[0].n) === 0) pass("no_waitlist_notifications_logged");
  else fail("no_waitlist_notifications_logged", String(notifCheck.rows[0].n));
} catch (e) {
  fail("controlled_suite_exception", e?.message || String(e));
} finally {
  await cleanup(customerIds, requestIds);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${failed.length ? "FAIL" : "PASS"} — ${results.filter((r) => r.ok).length}/${results.length} checks`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
