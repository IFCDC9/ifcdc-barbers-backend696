/**
 * Isolated HubSpot CRM integration (Phase 1: contacts).
 *
 * - Reads HUBSPOT_SERVICE_KEY and HUBSPOT_SYNC_ENABLED from process.env only.
 * - Never caches the service key — every request re-reads process.env.
 * - Never logs, returns, or serializes the service key.
 * - Failures are swallowed by callers via fire-and-forget enqueue helpers.
 */
import { dbQuery } from "./db.js";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;
/** Soft client-side spacing to stay under HubSpot private-app burst limits. */
const MIN_REQUEST_GAP_MS = 110;

let lastRequestAt = 0;
let requestChain = Promise.resolve();

function envFlag(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Canonical production API — the only Render service allowed to sync HubSpot. */
export const HUBSPOT_CANONICAL_SERVICE_ID = "srv-d6tmai24d50c73cdi0mg";
export const HUBSPOT_CANONICAL_SERVICE_NAME = "ifcdc-barbers-backend696";
export const HUBSPOT_CANONICAL_HOST = "ifcdc-barbers-backend696.onrender.com";

/**
 * HubSpot sync must only run on the canonical production service (or local/dev).
 * Secondary hosts (e.g. ifcdc-barbers-backend696-d8ui) are blocked even if env vars exist.
 */
export function isHubSpotCanonicalRuntime() {
  const serviceId = String(process.env.RENDER_SERVICE_ID || "").trim();
  if (serviceId) {
    return serviceId === HUBSPOT_CANONICAL_SERVICE_ID;
  }
  const serviceName = String(process.env.RENDER_SERVICE_NAME || "").trim();
  if (serviceName) {
    return serviceName === HUBSPOT_CANONICAL_SERVICE_NAME;
  }
  const external = String(process.env.RENDER_EXTERNAL_URL || "").trim().toLowerCase();
  if (external) {
    try {
      return new URL(external).hostname === HUBSPOT_CANONICAL_HOST;
    } catch {
      return false;
    }
  }
  // Not on Render (local/dev) — allow when env is configured for testing.
  return String(process.env.RENDER || "").trim() !== "true";
}

/** Feature flag — sync is a no-op when disabled or on a non-canonical host. */
export function isHubSpotSyncEnabled() {
  return envFlag("HUBSPOT_SYNC_ENABLED") && isHubSpotCanonicalRuntime();
}

/** Phase 2A — barbershop → HubSpot Company (requires master sync flag). */
export function isHubSpotCompanySyncEnabled() {
  return isHubSpotSyncEnabled() && envFlag("HUBSPOT_SYNC_COMPANIES");
}

/** Phase 2B — appointment → HubSpot Deal (requires master sync flag). */
export function isHubSpotDealSyncEnabled() {
  return isHubSpotSyncEnabled() && envFlag("HUBSPOT_SYNC_DEALS");
}

/**
 * Phase 2C — workflow property enrichment for HubSpot Automation.
 * When enabled, contact/deal syncs include lifecycle, loyalty, review, and birthday fields
 * that HubSpot workflows enroll on (emails stay in HubSpot, not Node).
 */
export function isHubSpotWorkflowSyncEnabled() {
  return isHubSpotSyncEnabled() && envFlag("HUBSPOT_SYNC_WORKFLOWS");
}

/**
 * Always read the live Render/process env value.
 * Do not store the key in module scope — rotated keys take effect immediately.
 */
function getServiceKey() {
  return String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
}

export function isHubSpotConfigured() {
  return Boolean(getServiceKey());
}

/** Safe diagnostics — env var NAMES only, never values. */
export function listHubSpotEnvNamesPresent() {
  return Object.keys(process.env)
    .filter((name) => /hubspot/i.test(name))
    .sort();
}

/** Drop in-flight request chain state after credential rotation / redeploy. */
export function clearHubSpotClientState() {
  lastRequestAt = 0;
  requestChain = Promise.resolve();
  console.log("[hubspot] client_state_cleared");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(error) {
  const raw = String(error?.message || error || "unknown_error");
  // Strip anything that looks like a bearer token or long secret.
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/pat-[A-Za-z0-9\-]+/gi, "[redacted]")
    .replace(getServiceKey() ? new RegExp(getServiceKey().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, "[redacted]")
    .slice(0, 400);
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: "", lastname: "" };
  if (parts.length === 1) return { firstname: parts[0], lastname: "" };
  return { firstname: parts[0], lastname: parts.slice(1).join(" ") };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function contactPropertiesFromUser(user) {
  const email = normalizeEmail(user?.email);
  const { firstname, lastname } = splitName(user?.name);
  const phone = String(user?.phone || "").trim();
  const props = { email };
  if (firstname) props.firstname = firstname;
  if (lastname) props.lastname = lastname;
  if (phone) props.phone = phone;

  if (!isHubSpotWorkflowSyncEnabled()) return props;

  if (user?.id) props.ifcdc_user_id = String(user.id);
  const lifecycle = String(user?.lifecycleStage || user?.ifcdc_lifecycle_stage || "").trim();
  if (lifecycle) props.ifcdc_lifecycle_stage = lifecycle.slice(0, 64);
  if (user?.registeredAt) {
    const d = new Date(user.registeredAt);
    if (!Number.isNaN(d.getTime())) props.ifcdc_registered_at = d.toISOString();
  }
  if (user?.dateOfBirth || user?.date_of_birth) {
    const raw = String(user.dateOfBirth || user.date_of_birth).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      props.date_of_birth = raw;
      props.ifcdc_date_of_birth = raw;
    }
  }
  if (user?.loyaltyPoints != null && Number.isFinite(Number(user.loyaltyPoints))) {
    props.ifcdc_loyalty_points = String(Number(user.loyaltyPoints));
  }
  if (user?.loyaltyLifetimeEarned != null && Number.isFinite(Number(user.loyaltyLifetimeEarned))) {
    props.ifcdc_loyalty_lifetime_earned = String(Number(user.loyaltyLifetimeEarned));
  }
  if (user?.loyaltyCompletedHaircuts != null && Number.isFinite(Number(user.loyaltyCompletedHaircuts))) {
    props.ifcdc_loyalty_completed_haircuts = String(Number(user.loyaltyCompletedHaircuts));
  }
  if (user?.loyaltyLastEvent) {
    props.ifcdc_loyalty_last_event = String(user.loyaltyLastEvent).slice(0, 64);
  }
  if (user?.loyaltyLastReward) {
    props.ifcdc_loyalty_last_reward = String(user.loyaltyLastReward).slice(0, 256);
  }
  if (user?.lastCompletedAt) {
    const d = new Date(user.lastCompletedAt);
    if (!Number.isNaN(d.getTime())) props.ifcdc_last_completed_at = d.toISOString();
  }
  if (user?.preferredBarberId != null) {
    props.ifcdc_preferred_barber_id = String(user.preferredBarberId);
  }
  if (user?.rebookEligible === true || user?.rebookEligible === "true") {
    props.ifcdc_rebook_eligible = "true";
  }
  return props;
}

/**
 * Load loyalty + birthday fields for workflow property enrichment.
 * Never throws — returns the input user with optional extras.
 */
export async function enrichContactUserForWorkflows(user, { reason = "sync" } = {}) {
  const base = { ...(user || {}) };
  if (!isHubSpotWorkflowSyncEnabled()) return base;

  const userId = base.id ? String(base.id) : null;
  if (!userId) return base;

  try {
    const row = await dbQuery(
      `SELECT id, name, email, phone, role, barber_id, business_id, created_at,
              date_of_birth
       FROM app_users WHERE id = $1::uuid LIMIT 1`,
      [userId],
    ).catch(() => ({ rows: [] }));
    const u = row.rows?.[0];
    if (u) {
      base.email = base.email || u.email;
      base.name = base.name || u.name;
      base.phone = base.phone ?? u.phone;
      base.role = base.role || u.role;
      if (u.date_of_birth) base.dateOfBirth = String(u.date_of_birth).slice(0, 10);
      if (u.created_at && !base.registeredAt) base.registeredAt = u.created_at;
      if (u.barber_id != null && base.preferredBarberId == null) {
        base.preferredBarberId = u.barber_id;
      }
    }
  } catch {
    // ignore
  }

  try {
    const loyalty = await dbQuery(
      `SELECT points_balance, lifetime_earned, completed_haircuts
       FROM loyalty_accounts WHERE user_id = $1::uuid LIMIT 1`,
      [userId],
    ).catch(() => ({ rows: [] }));
    const acct = loyalty.rows?.[0];
    if (acct) {
      if (base.loyaltyPoints == null) base.loyaltyPoints = Number(acct.points_balance) || 0;
      if (base.loyaltyLifetimeEarned == null) {
        base.loyaltyLifetimeEarned = Number(acct.lifetime_earned) || 0;
      }
      if (base.loyaltyCompletedHaircuts == null) {
        base.loyaltyCompletedHaircuts = Number(acct.completed_haircuts) || 0;
      }
    }
  } catch {
    // ignore
  }

  // Welcome / registration enrollment signal
  if (/register|signup|google_register|apple_register/i.test(String(reason || ""))) {
    if (!base.lifecycleStage) base.lifecycleStage = "registered";
  }

  return base;
}

async function recordEvent({ entityType, localId, action, status, httpStatus = null, message = null }) {
  try {
    await dbQuery(
      `INSERT INTO hubspot_sync_events (entity_type, local_id, action, status, http_status, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entityType, localId == null ? null : String(localId), action, status, httpStatus, message],
    );
  } catch {
    // Mapping tables may not exist yet during early boot; never throw.
  }
}

async function upsertLocalContactRow({
  userId,
  email,
  hubspotContactId = null,
  status,
  error = null,
}) {
  if (!userId || !email) return;
  try {
    await dbQuery(
      `INSERT INTO hubspot_sync_contacts
         (user_id, email, hubspot_contact_id, last_synced_at, last_sync_status, last_error, sync_attempts, updated_at)
       VALUES ($1::uuid, $2, $3, CASE WHEN $4 = 'synced' THEN NOW() ELSE NULL END, $4, $5, 1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email,
         hubspot_contact_id = COALESCE(EXCLUDED.hubspot_contact_id, hubspot_sync_contacts.hubspot_contact_id),
         last_synced_at = CASE WHEN EXCLUDED.last_sync_status = 'synced' THEN NOW() ELSE hubspot_sync_contacts.last_synced_at END,
         last_sync_status = EXCLUDED.last_sync_status,
         last_error = EXCLUDED.last_error,
         sync_attempts = hubspot_sync_contacts.sync_attempts + 1,
         updated_at = NOW()`,
      [String(userId), email, hubspotContactId, status, error],
    );
  } catch (e) {
    console.warn("[hubspot] local mapping update skipped:", sanitizeErrorMessage(e));
  }
}

/**
 * Serialize outbound HubSpot HTTP calls with spacing + retries.
 * Never includes the service key in thrown messages or logs.
 */
async function hubspotRequest(path, { method = "GET", body = null } = {}) {
  const key = getServiceKey();
  if (!key) {
    const err = new Error("hubspot_not_configured");
    err.code = "hubspot_not_configured";
    throw err;
  }

  const run = async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const gap = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
      if (gap > 0) await sleep(gap);
      lastRequestAt = Date.now();

      let response;
      try {
        response = await fetch(`${HUBSPOT_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body == null ? undefined : JSON.stringify(body),
        });
      } catch (networkError) {
        lastError = networkError;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        const err = new Error(sanitizeErrorMessage(networkError));
        err.code = "hubspot_network_error";
        throw err;
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after")) || 0;
        const waitMs = Math.max(retryAfter * 1000, BASE_BACKOFF_MS * 2 ** attempt);
        if (attempt < MAX_RETRIES) {
          await sleep(waitMs);
          continue;
        }
        const err = new Error(`hubspot_http_${response.status}`);
        err.code = "hubspot_rate_or_server";
        err.status = response.status;
        throw err;
      }

      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        const err = new Error(
          sanitizeErrorMessage(data?.message || data?.error || `hubspot_http_${response.status}`),
        );
        err.code = "hubspot_http_error";
        err.status = response.status;
        err.category = data?.category || null;
        throw err;
      }
      return { status: response.status, data };
    }
    throw lastError || new Error("hubspot_request_failed");
  };

  // Chain requests so concurrent syncs still respect MIN_REQUEST_GAP_MS.
  const next = requestChain.then(run, run);
  requestChain = next.catch(() => {});
  return next;
}

async function probeObjectPermission(objectType) {
  try {
    await hubspotRequest(`/crm/v3/objects/${objectType}?limit=1`);
    return { ok: true, status: 200, message: "ok" };
  } catch (error) {
    return {
      ok: false,
      status: error?.status || null,
      message: sanitizeErrorMessage(error),
    };
  }
}

/**
 * Probe CRM scopes needed for Phase 1 (contacts) and Phase 2 readiness (companies/deals).
 * Never returns credential material.
 */
export async function probeHubSpotPermissions() {
  const [contacts, companies, deals] = await Promise.all([
    probeObjectPermission("contacts"),
    probeObjectPermission("companies"),
    probeObjectPermission("deals"),
  ]);
  return { contacts, companies, deals };
}

/**
 * Verify the private app token can call HubSpot (token info / account).
 * Returns a public-safe summary — never the key.
 */
export async function verifyHubSpotAuthentication({ includePermissions = true } = {}) {
  clearHubSpotClientState();

  if (!isHubSpotConfigured()) {
    return {
      ok: false,
      configured: false,
      syncEnabled: isHubSpotSyncEnabled(),
      authenticated: false,
      permissions: null,
      message: "HUBSPOT_SERVICE_KEY is not set",
    };
  }

  try {
    // Lightweight authenticated call — account details without listing contacts.
    const { status, data } = await hubspotRequest("/account-info/v3/details");
    const portalId = data?.portalId ?? data?.portal_id ?? null;
    const permissions = includePermissions ? await probeHubSpotPermissions() : null;
    const permissionOk = !permissions
      || (permissions.contacts?.ok && permissions.companies?.ok && permissions.deals?.ok);
    console.log("[hubspot] auth_ok", {
      httpStatus: status,
      portalId: portalId == null ? null : String(portalId),
      syncEnabled: isHubSpotSyncEnabled(),
      contacts: permissions?.contacts?.ok ?? null,
      companies: permissions?.companies?.ok ?? null,
      deals: permissions?.deals?.ok ?? null,
    });
    return {
      ok: true,
      configured: true,
      syncEnabled: isHubSpotSyncEnabled(),
      authenticated: true,
      permissionsOk: Boolean(permissionOk),
      permissions,
      portalId: portalId == null ? null : String(portalId),
      timeZone: data?.timeZone || data?.utcOffset || null,
      message: permissionOk
        ? "HubSpot authentication succeeded"
        : "HubSpot authenticated, but one or more CRM object permissions failed",
    };
  } catch (error) {
    console.warn("[hubspot] auth_failed", {
      code: error?.code || "error",
      status: error?.status || null,
      message: sanitizeErrorMessage(error),
    });
    return {
      ok: false,
      configured: true,
      syncEnabled: isHubSpotSyncEnabled(),
      authenticated: false,
      permissions: null,
      message: sanitizeErrorMessage(error),
      httpStatus: error?.status || null,
    };
  }
}

export async function getHubSpotHealth() {
  const configured = isHubSpotConfigured();
  const syncEnabled = isHubSpotSyncEnabled();
  if (!configured) {
    return {
      ok: false,
      configured: false,
      syncEnabled,
      authenticated: false,
      permissions: null,
      serviceKey: "missing",
      message: "HubSpot not configured",
    };
  }
  const auth = await verifyHubSpotAuthentication({ includePermissions: true });
  const permissionsOk = auth.permissions
    ? Boolean(auth.permissions.contacts?.ok && auth.permissions.companies?.ok && auth.permissions.deals?.ok)
    : false;
  return {
    ok: Boolean(auth.ok && auth.authenticated && permissionsOk),
    configured: true,
    syncEnabled,
    authenticated: Boolean(auth.authenticated),
    permissionsOk,
    permissions: auth.permissions || null,
    serviceKey: "configured",
    portalId: auth.portalId || null,
    message: auth.message,
    httpStatus: auth.httpStatus || null,
  };
}

/**
 * Admin/ops contact round-trip: create (or find), then update, using email as unique key.
 * Uses the live HUBSPOT_SERVICE_KEY from process.env on every request.
 */
export async function testContactSyncRoundTrip({
  email,
  name = "IFCDC HubSpot Phase1 Test",
  phone = "",
} = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, message: "A valid test email is required." };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, message: "HUBSPOT_SERVICE_KEY is not set" };
  }

  clearHubSpotClientState();

  const previousSyncFlag = process.env.HUBSPOT_SYNC_ENABLED;
  process.env.HUBSPOT_SYNC_ENABLED = "1";
  try {
    const created = await syncContactToHubSpot(
      { id: null, email: normalized, name, phone, role: "user" },
      { reason: "admin_test_create" },
    );
    if (!created.ok) {
      return {
        ok: false,
        step: "create_or_update",
        message: created.message || created.reason || "contact sync failed",
        action: created.action || null,
      };
    }

    const updated = await syncContactToHubSpot(
      { id: null, email: normalized, name: `${name} Updated`, phone, role: "user" },
      { reason: "admin_test_update" },
    );
    if (!updated.ok) {
      return {
        ok: false,
        step: "update",
        message: updated.message || updated.reason || "contact update failed",
        hubspotContactId: created.hubspotContactId || null,
      };
    }

    const sameId =
      Boolean(created.hubspotContactId)
      && created.hubspotContactId === updated.hubspotContactId;

    return {
      ok: true,
      createAction: created.action,
      updateAction: updated.action,
      hubspotContactId: updated.hubspotContactId,
      duplicatePrevented: sameId,
      message: sameId
        ? "Contact create/update succeeded; email keyed to a single HubSpot contact"
        : "Contact sync succeeded but contact IDs differed between passes",
    };
  } finally {
    if (previousSyncFlag == null) delete process.env.HUBSPOT_SYNC_ENABLED;
    else process.env.HUBSPOT_SYNC_ENABLED = previousSyncFlag;
  }
}

async function findContactIdByEmail(email) {
  const encoded = encodeURIComponent(email);
  try {
    const { data } = await hubspotRequest(`/crm/v3/objects/contacts/${encoded}?idProperty=email`);
    return data?.id ? String(data.id) : null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function stripCustomContactProps(properties) {
  const keep = ["email", "firstname", "lastname", "phone", "date_of_birth"];
  const out = {};
  for (const k of keep) {
    if (properties[k] != null && properties[k] !== "") out[k] = properties[k];
  }
  return out;
}

async function createContact(properties) {
  try {
    const { data } = await hubspotRequest("/crm/v3/objects/contacts", {
      method: "POST",
      body: { properties },
    });
    return data?.id ? String(data.id) : null;
  } catch (error) {
    // Concurrent create or pre-existing CRM contact — fall back to email lookup.
    if (error?.status === 409 || /already|exists|conflict/i.test(String(error?.message || ""))) {
      return null;
    }
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const { data } = await hubspotRequest("/crm/v3/objects/contacts", {
        method: "POST",
        body: { properties: stripCustomContactProps(properties) },
      });
      return data?.id ? String(data.id) : null;
    }
    throw error;
  }
}

async function updateContact(contactId, properties) {
  try {
    const { data } = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
      method: "PATCH",
      body: { properties },
    });
    return data?.id ? String(data.id) : String(contactId);
  } catch (error) {
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const { data } = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
        method: "PATCH",
        body: { properties: stripCustomContactProps(properties) },
      });
      return data?.id ? String(data.id) : String(contactId);
    }
    throw error;
  }
}

/**
 * Upsert a HubSpot Contact using email as the unique lookup key.
 * Safe to call repeatedly; returns a public-safe result object.
 */
export async function syncContactToHubSpot(user, { reason = "sync" } = {}) {
  const email = normalizeEmail(user?.email);
  const userId = user?.id ? String(user.id) : null;

  if (!email || !email.includes("@")) {
    return { ok: false, skipped: true, reason: "missing_email" };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!isHubSpotSyncEnabled()) {
    return { ok: false, skipped: true, reason: "sync_disabled" };
  }

  const enriched = await enrichContactUserForWorkflows({ ...user, email }, { reason });
  const properties = contactPropertiesFromUser(enriched);

  try {
    let contactId = await findContactIdByEmail(email);
    let action;
    if (contactId) {
      contactId = await updateContact(contactId, properties);
      action = "contact_updated";
    } else {
      contactId = await createContact(properties);
      action = "contact_created";
      if (!contactId) {
        // Race: create may fail if contact appeared; re-lookup and update.
        contactId = await findContactIdByEmail(email);
        if (contactId) {
          contactId = await updateContact(contactId, properties);
          action = "contact_updated";
        }
      }
    }

    if (!contactId) {
      throw new Error("hubspot_contact_id_missing");
    }

    await upsertLocalContactRow({
      userId,
      email,
      hubspotContactId: contactId,
      status: "synced",
      error: null,
    });
    await recordEvent({
      entityType: "contact",
      localId: userId || email,
      action,
      status: "ok",
      httpStatus: action === "contact_created" ? 201 : 200,
      message: reason,
    });

    // Starter path: property-triggered HubSpot Workflows are Professional-only.
    // Deliver welcome via Resend (HubSpot single-send attempted first).
    try {
      const { enqueueStarterWelcome } = await import("./hubspotStarterAutomationService.js");
      enqueueStarterWelcome({ email, name: enriched?.name || user?.name, reason });
      if (enriched?.dateOfBirth || enriched?.date_of_birth) {
        const { runStarterAutomationEmail } = await import("./hubspotStarterAutomationService.js");
        void runStarterAutomationEmail("birthday", {
          to: email,
          name: enriched?.name || user?.name,
        }).catch(() => {});
      }
    } catch {
      // never block CRM sync
    }

    // Preserve shop relationships: associate contact → company when mapping exists.
    if (userId && isHubSpotCompanySyncEnabled()) {
      try {
        const biz = await dbQuery(
          `SELECT COALESCE(
             u.business_id,
             (SELECT b.business_id FROM barbers b WHERE b.id = u.barber_id LIMIT 1)
           ) AS business_id
           FROM app_users u WHERE u.id = $1::uuid LIMIT 1`,
          [String(userId)],
        );
        const businessId = biz.rows?.[0]?.business_id;
        if (businessId != null) {
          const companyMap = await dbQuery(
            `SELECT hubspot_company_id FROM hubspot_sync_companies
             WHERE business_id = $1::bigint AND hubspot_company_id IS NOT NULL LIMIT 1`,
            [Number(businessId)],
          );
          const companyId = companyMap.rows?.[0]?.hubspot_company_id;
          if (companyId) {
            await associateContactToCompany(contactId, String(companyId));
          }
        }
      } catch (assocErr) {
        console.warn("[hubspot] contact_company_link_skipped:", sanitizeErrorMessage(assocErr));
      }
    }

    console.log("[hubspot] contact_sync_ok", {
      action,
      reason,
      hasUserId: Boolean(userId),
      contactIdSuffix: contactId.slice(-6),
    });

    return {
      ok: true,
      action,
      hubspotContactId: contactId,
      reason,
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await upsertLocalContactRow({
      userId,
      email,
      status: "error",
      error: message,
    });
    await recordEvent({
      entityType: "contact",
      localId: userId || email,
      action: "contact_sync",
      status: "error",
      httpStatus: error?.status || null,
      message,
    });
    console.warn("[hubspot] contact_sync_failed", {
      reason,
      code: error?.code || "error",
      status: error?.status || null,
      message,
    });
    return { ok: false, reason, message };
  }
}

/**
 * Fire-and-forget enqueue — never throws to the caller.
 * Use after successful registration / profile update.
 */
export function enqueueContactSync(user, options = {}) {
  try {
    if (!isHubSpotConfigured() || !isHubSpotSyncEnabled()) return;
    const email = normalizeEmail(user?.email);
    if (!email) return;
    void syncContactToHubSpot(user, options).catch((error) => {
      console.warn("[hubspot] enqueue sync error:", sanitizeErrorMessage(error));
    });
  } catch (error) {
    console.warn("[hubspot] enqueue failed:", sanitizeErrorMessage(error));
  }
}

/**
 * Refresh contact workflow properties (loyalty / birthday / rebook) by user id.
 * Fire-and-forget — never throws.
 */
export function enqueueContactWorkflowRefresh(userId, options = {}) {
  try {
    if (!isHubSpotConfigured() || !isHubSpotSyncEnabled() || !isHubSpotWorkflowSyncEnabled()) return;
    const id = String(userId || "").trim();
    if (!id) return;
    void (async () => {
      const row = await dbQuery(
        `SELECT id, name, email, phone, role, barber_id, date_of_birth, created_at
         FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [id],
      );
      const user = row.rows?.[0];
      if (!user?.email) return;
      await syncContactToHubSpot(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          role: user.role,
          dateOfBirth: user.date_of_birth,
          registeredAt: user.created_at,
          preferredBarberId: user.barber_id,
          loyaltyLastEvent: options.loyaltyLastEvent || null,
          loyaltyLastReward: options.loyaltyLastReward || null,
          lastCompletedAt: options.lastCompletedAt || null,
          rebookEligible: options.rebookEligible === true,
          lifecycleStage: options.lifecycleStage || null,
          loyaltyPoints: options.loyaltyPoints,
          loyaltyLifetimeEarned: options.loyaltyLifetimeEarned,
          loyaltyCompletedHaircuts: options.loyaltyCompletedHaircuts,
        },
        { reason: options.reason || "workflow_refresh" },
      );
    })().catch((error) => {
      console.warn("[hubspot] workflow contact refresh error:", sanitizeErrorMessage(error));
    });
  } catch (error) {
    console.warn("[hubspot] workflow contact refresh failed:", sanitizeErrorMessage(error));
  }
}

const PHASE1_TEST_EMAIL_SQL = `
  lower(email) LIKE 'phase1.%@%'
  OR lower(email) LIKE 'hubspot.phase1%@%'
  OR lower(email) LIKE 'phase1.verify.%@%'
`;

async function deleteHubSpotContactById(contactId) {
  const id = String(contactId || "").trim();
  if (!id) return { ok: false, reason: "missing_id" };
  try {
    await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return { ok: true };
  } catch (error) {
    if (error?.status === 404) return { ok: true, alreadyGone: true };
    return { ok: false, message: sanitizeErrorMessage(error), httpStatus: error?.status || null };
  }
}

/**
 * Remove Phase 1 verification contacts from HubSpot + local mappings/users.
 * Safe patterns only (phase1.* / hubspot.phase1*).
 */
export async function cleanupPhase1TestArtifacts({ deleteAppUsers = true } = {}) {
  const summary = {
    ok: true,
    hubspotDeleted: 0,
    hubspotFailed: 0,
    mappingsDeleted: 0,
    usersDeleted: 0,
    emails: [],
  };

  const mapped = await dbQuery(
    `SELECT user_id, email, hubspot_contact_id
     FROM hubspot_sync_contacts
     WHERE ${PHASE1_TEST_EMAIL_SQL}`,
  );
  const users = await dbQuery(
    `SELECT id, email FROM app_users
     WHERE ${PHASE1_TEST_EMAIL_SQL}
        OR name ILIKE 'Phase1 Register%'
        OR name ILIKE 'IFCDC Phase1%'
        OR name ILIKE 'IFCDC HubSpot Phase1%'
        OR name ILIKE 'HubSpot Phase1%'`,
  );

  const contactIds = new Set();
  const emails = new Set();
  for (const row of mapped.rows || []) {
    if (row.hubspot_contact_id) contactIds.add(String(row.hubspot_contact_id));
    if (row.email) emails.add(normalizeEmail(row.email));
  }
  for (const row of users.rows || []) {
    if (row.email) emails.add(normalizeEmail(row.email));
  }

  // Also resolve HubSpot IDs by email when mapping rows are missing.
  if (isHubSpotConfigured()) {
    for (const email of emails) {
      try {
        const id = await findContactIdByEmail(email);
        if (id) contactIds.add(id);
      } catch {
        // continue — best effort
      }
    }
    for (const contactId of contactIds) {
      const result = await deleteHubSpotContactById(contactId);
      if (result.ok) summary.hubspotDeleted += 1;
      else {
        summary.hubspotFailed += 1;
        summary.ok = false;
      }
    }
  }

  const delMaps = await dbQuery(
    `DELETE FROM hubspot_sync_contacts WHERE ${PHASE1_TEST_EMAIL_SQL} RETURNING email`,
  );
  summary.mappingsDeleted = delMaps.rows?.length || 0;

  if (deleteAppUsers) {
    const delUsers = await dbQuery(
      `DELETE FROM app_users
       WHERE ${PHASE1_TEST_EMAIL_SQL}
          OR name ILIKE 'Phase1 Register%'
          OR name ILIKE 'IFCDC Phase1%'
          OR name ILIKE 'IFCDC HubSpot Phase1%'
          OR name ILIKE 'HubSpot Phase1%'
       RETURNING email`,
    );
    summary.usersDeleted = delUsers.rows?.length || 0;
    for (const row of delUsers.rows || []) {
      if (row.email) emails.add(normalizeEmail(row.email));
    }
  }

  await dbQuery(
    `DELETE FROM hubspot_sync_events
     WHERE message ILIKE '%phase1%'
        OR message ILIKE '%admin_test_%'
        OR local_id ILIKE 'phase1.%'
        OR local_id ILIKE 'hubspot.phase1%'`,
  ).catch(() => {});

  summary.emails = [...emails].map((e) => e.replace(/^(.{3}).+(@.+)$/, "$1***$2"));
  await recordEvent({
    entityType: "contact",
    localId: "phase1_cleanup",
    action: "cleanup_phase1_tests",
    status: summary.ok ? "ok" : "partial",
    message: `hubspotDeleted=${summary.hubspotDeleted};usersDeleted=${summary.usersDeleted}`,
  });
  return summary;
}

async function upsertLocalCompanyRow({
  businessId,
  hubspotCompanyId = null,
  status,
  error = null,
  metadata = null,
}) {
  if (businessId == null) return;
  try {
    await dbQuery(
      `INSERT INTO hubspot_sync_companies
         (business_id, hubspot_company_id, last_synced_at, last_sync_status, last_error, sync_attempts, metadata, updated_at)
       VALUES ($1::bigint, $2, CASE WHEN $3 = 'synced' THEN NOW() ELSE NULL END, $3, $4, 1,
               COALESCE($5::jsonb, '{}'::jsonb), NOW())
       ON CONFLICT (business_id) DO UPDATE SET
         hubspot_company_id = COALESCE(EXCLUDED.hubspot_company_id, hubspot_sync_companies.hubspot_company_id),
         last_synced_at = CASE WHEN EXCLUDED.last_sync_status = 'synced' THEN NOW() ELSE hubspot_sync_companies.last_synced_at END,
         last_sync_status = EXCLUDED.last_sync_status,
         last_error = EXCLUDED.last_error,
         sync_attempts = hubspot_sync_companies.sync_attempts + 1,
         metadata = COALESCE(EXCLUDED.metadata, hubspot_sync_companies.metadata),
         updated_at = NOW()`,
      [
        Number(businessId),
        hubspotCompanyId,
        status,
        error,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    console.warn("[hubspot] local company mapping update skipped:", sanitizeErrorMessage(e));
  }
}

function companyPropertiesFromBusiness(business) {
  const name = String(business?.name || "").trim();
  const phone = String(business?.phone || "").trim();
  const address = String(business?.address || "").trim();
  const city = String(business?.city || "").trim();
  const state = String(business?.state || "").trim();
  const props = {
    name: name || `IFCDC Shop ${business?.id}`,
    ifcdc_business_id: String(business.id),
  };
  if (phone) props.phone = phone;
  if (address) props.address = address;
  if (city) props.city = city;
  if (state) props.state = state;
  const status = String(business?.approval_status || business?.account_status || "").trim();
  if (status) props.ifcdc_shop_status = status.slice(0, 64);
  const plan = String(business?.access_plan || business?.plan || "").trim();
  if (plan) props.ifcdc_access_plan = plan.slice(0, 64);
  return props;
}

async function findCompanyIdByBusinessId(businessId) {
  try {
    const mapped = await dbQuery(
      `SELECT hubspot_company_id FROM hubspot_sync_companies
       WHERE business_id = $1::bigint AND hubspot_company_id IS NOT NULL LIMIT 1`,
      [Number(businessId)],
    );
    if (mapped.rows?.[0]?.hubspot_company_id) {
      return String(mapped.rows[0].hubspot_company_id);
    }
  } catch {
    // Mapping table / DB may be unavailable in unit tests — continue to HubSpot search.
  }

  try {
    const { data } = await hubspotRequest("/crm/v3/objects/companies/search", {
      method: "POST",
      body: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "ifcdc_business_id",
                operator: "EQ",
                value: String(businessId),
              },
            ],
          },
        ],
        properties: ["name", "ifcdc_business_id"],
        limit: 1,
      },
    });
    const id = data?.results?.[0]?.id;
    return id ? String(id) : null;
  } catch (error) {
    // Custom property may not exist yet — fall through to create by local mapping only.
    if (error?.status === 400 || error?.status === 404) return null;
    throw error;
  }
}

async function createCompany(properties) {
  try {
    const { data } = await hubspotRequest("/crm/v3/objects/companies", {
      method: "POST",
      body: { properties },
    });
    return data?.id ? String(data.id) : null;
  } catch (error) {
    // Retry without custom IFCDC properties if HubSpot portal lacks them.
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const fallback = {
        name: properties.name,
      };
      if (properties.phone) fallback.phone = properties.phone;
      if (properties.address) fallback.address = properties.address;
      if (properties.city) fallback.city = properties.city;
      if (properties.state) fallback.state = properties.state;
      const { data } = await hubspotRequest("/crm/v3/objects/companies", {
        method: "POST",
        body: { properties: fallback },
      });
      return data?.id ? String(data.id) : null;
    }
    throw error;
  }
}

async function updateCompany(companyId, properties) {
  try {
    const { data } = await hubspotRequest(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
      method: "PATCH",
      body: { properties },
    });
    return data?.id ? String(data.id) : String(companyId);
  } catch (error) {
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const fallback = { name: properties.name };
      if (properties.phone) fallback.phone = properties.phone;
      if (properties.address) fallback.address = properties.address;
      if (properties.city) fallback.city = properties.city;
      if (properties.state) fallback.state = properties.state;
      const { data } = await hubspotRequest(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
        method: "PATCH",
        body: { properties: fallback },
      });
      return data?.id ? String(data.id) : String(companyId);
    }
    throw error;
  }
}

/** HubSpot-defined association: contact → company. */
const CONTACT_TO_COMPANY_ASSOCIATION_TYPE_ID = 1;

async function associateContactToCompany(contactId, companyId) {
  if (!contactId || !companyId) return { ok: false, skipped: true };
  try {
    await hubspotRequest(
      `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/companies/${encodeURIComponent(companyId)}`,
      {
        method: "PUT",
        body: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: CONTACT_TO_COMPANY_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    );
    return { ok: true };
  } catch (error) {
    // Already associated or type mismatch — soft fail.
    if (error?.status === 409) return { ok: true, alreadyAssociated: true };
    console.warn("[hubspot] contact_company_association_failed", {
      message: sanitizeErrorMessage(error),
      status: error?.status || null,
    });
    return { ok: false, message: sanitizeErrorMessage(error) };
  }
}

/**
 * Link existing HubSpot contacts (shop owners + barbers) to the company.
 * Preserves shop ↔ barber ↔ client relationships via HubSpot associations.
 */
async function associateBusinessContactsToCompany(businessId, companyId) {
  const related = await dbQuery(
    `SELECT DISTINCT c.hubspot_contact_id
     FROM hubspot_sync_contacts c
     INNER JOIN app_users u ON u.id = c.user_id
     WHERE c.hubspot_contact_id IS NOT NULL
       AND (
         u.business_id = $1::bigint
         OR u.barber_id IN (SELECT id FROM barbers WHERE business_id = $1::bigint)
       )`,
    [Number(businessId)],
  ).catch(() => ({ rows: [] }));

  let associated = 0;
  for (const row of related.rows || []) {
    const result = await associateContactToCompany(String(row.hubspot_contact_id), companyId);
    if (result.ok) associated += 1;
  }
  return { associated, attempted: (related.rows || []).length };
}

export async function loadBusinessForHubSpot(businessId) {
  const id = Number(businessId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const r = await dbQuery(
    `SELECT id, name, phone, address, city, state,
            approval_status, account_status, access_plan, plan, subscription_status
     FROM businesses WHERE id = $1::bigint LIMIT 1`,
    [id],
  );
  return r.rows?.[0] || null;
}

/**
 * Upsert a HubSpot Company for an IFCDC business (barbershop).
 * Idempotent via hubspot_sync_companies + ifcdc_business_id lookup.
 */
export async function syncCompanyToHubSpot(business, { reason = "sync" } = {}) {
  const businessId = business?.id != null ? Number(business.id) : null;
  if (!businessId || !Number.isFinite(businessId)) {
    return { ok: false, skipped: true, reason: "missing_business_id" };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!isHubSpotCompanySyncEnabled()) {
    return { ok: false, skipped: true, reason: "company_sync_disabled" };
  }

  const properties = companyPropertiesFromBusiness(business);

  try {
    let companyId = await findCompanyIdByBusinessId(businessId);
    let action;
    if (companyId) {
      companyId = await updateCompany(companyId, properties);
      action = "company_updated";
    } else {
      companyId = await createCompany(properties);
      action = "company_created";
    }

    if (!companyId) throw new Error("hubspot_company_id_missing");

    const associations = await associateBusinessContactsToCompany(businessId, companyId);

    await upsertLocalCompanyRow({
      businessId,
      hubspotCompanyId: companyId,
      status: "synced",
      error: null,
      metadata: { associations, reason },
    });
    await recordEvent({
      entityType: "company",
      localId: String(businessId),
      action,
      status: "ok",
      httpStatus: action === "company_created" ? 201 : 200,
      message: reason,
    });

    console.log("[hubspot] company_sync_ok", {
      action,
      reason,
      businessId,
      companyIdSuffix: companyId.slice(-6),
      associations: associations.associated,
    });

    return {
      ok: true,
      action,
      hubspotCompanyId: companyId,
      associations,
      reason,
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await upsertLocalCompanyRow({
      businessId,
      status: "error",
      error: message,
    });
    await recordEvent({
      entityType: "company",
      localId: String(businessId),
      action: "company_sync",
      status: "error",
      httpStatus: error?.status || null,
      message,
    });
    console.warn("[hubspot] company_sync_failed", {
      reason,
      businessId,
      code: error?.code || "error",
      status: error?.status || null,
      message,
    });
    return { ok: false, reason, message };
  }
}

/**
 * Fire-and-forget company sync by business id — never throws to the caller.
 */
export function enqueueCompanySyncById(businessId, options = {}) {
  try {
    if (!isHubSpotConfigured() || !isHubSpotCompanySyncEnabled()) return;
    const id = Number(businessId);
    if (!Number.isFinite(id) || id <= 0) return;
    void (async () => {
      const business = await loadBusinessForHubSpot(id);
      if (!business) return;
      await syncCompanyToHubSpot(business, options);
    })().catch((error) => {
      console.warn("[hubspot] enqueue company sync error:", sanitizeErrorMessage(error));
    });
  } catch (error) {
    console.warn("[hubspot] enqueue company failed:", sanitizeErrorMessage(error));
  }
}

/**
 * Admin/ops company round-trip: sync once, then update, confirming same HubSpot company id.
 */
export async function testCompanySyncRoundTrip(businessId) {
  const business = await loadBusinessForHubSpot(businessId);
  if (!business) {
    return { ok: false, message: "Business not found" };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, message: "HUBSPOT_SERVICE_KEY is not set" };
  }

  const previous = process.env.HUBSPOT_SYNC_COMPANIES;
  const previousMaster = process.env.HUBSPOT_SYNC_ENABLED;
  process.env.HUBSPOT_SYNC_ENABLED = "1";
  process.env.HUBSPOT_SYNC_COMPANIES = "1";
  try {
    clearHubSpotClientState();
    const created = await syncCompanyToHubSpot(business, { reason: "admin_test_company_create" });
    if (!created.ok) {
      return {
        ok: false,
        step: "create_or_update",
        message: created.message || created.reason || "company sync failed",
        action: created.action || null,
      };
    }
    const updated = await syncCompanyToHubSpot(business, { reason: "admin_test_company_update" });
    if (!updated.ok) {
      return {
        ok: false,
        step: "update",
        message: updated.message || updated.reason,
        hubspotCompanyId: created.hubspotCompanyId || null,
      };
    }
    const sameId =
      Boolean(created.hubspotCompanyId)
      && created.hubspotCompanyId === updated.hubspotCompanyId;
    return {
      ok: true,
      createAction: created.action,
      updateAction: updated.action,
      hubspotCompanyId: updated.hubspotCompanyId,
      duplicatePrevented: sameId,
      associations: updated.associations || created.associations || null,
      message: sameId
        ? "Company create/update succeeded; business_id keyed to a single HubSpot company"
        : "Company sync succeeded but company IDs differed between passes",
    };
  } finally {
    if (previous == null) delete process.env.HUBSPOT_SYNC_COMPANIES;
    else process.env.HUBSPOT_SYNC_COMPANIES = previous;
    if (previousMaster == null) delete process.env.HUBSPOT_SYNC_ENABLED;
    else process.env.HUBSPOT_SYNC_ENABLED = previousMaster;
  }
}

async function upsertLocalDealRow({
  bookingId,
  hubspotDealId = null,
  status,
  error = null,
  metadata = null,
}) {
  if (!bookingId) return;
  try {
    await dbQuery(
      `INSERT INTO hubspot_sync_deals
         (booking_id, hubspot_deal_id, last_synced_at, last_sync_status, last_error, sync_attempts, metadata, updated_at)
       VALUES ($1::uuid, $2, CASE WHEN $3 = 'synced' THEN NOW() ELSE NULL END, $3, $4, 1,
               COALESCE($5::jsonb, '{}'::jsonb), NOW())
       ON CONFLICT (booking_id) DO UPDATE SET
         hubspot_deal_id = COALESCE(EXCLUDED.hubspot_deal_id, hubspot_sync_deals.hubspot_deal_id),
         last_synced_at = CASE WHEN EXCLUDED.last_sync_status = 'synced' THEN NOW() ELSE hubspot_sync_deals.last_synced_at END,
         last_sync_status = EXCLUDED.last_sync_status,
         last_error = EXCLUDED.last_error,
         sync_attempts = hubspot_sync_deals.sync_attempts + 1,
         metadata = COALESCE(EXCLUDED.metadata, hubspot_sync_deals.metadata),
         updated_at = NOW()`,
      [
        String(bookingId),
        hubspotDealId,
        status,
        error,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    console.warn("[hubspot] local deal mapping update skipped:", sanitizeErrorMessage(e));
  }
}

function isBookingPaidForHubSpot(booking) {
  const ps = String(booking?.payment_status || "").toLowerCase();
  if (booking?.is_paid_booking === true) return true;
  if (["paid", "paid_full", "paid_in_full", "captured"].includes(ps)) return true;
  const paidAmt = Number(booking?.amount_paid ?? booking?.total_paid ?? booking?.amount_charged ?? 0);
  return Number.isFinite(paidAmt) && paidAmt > 0;
}

/**
 * Map IFCDC booking lifecycle → HubSpot deal pipeline key + optional stage id.
 * Stage IDs are optional Render env vars (portal-specific).
 */
export function resolveHubSpotDealPipeline(booking) {
  const status = String(booking?.booking_status || "").toLowerCase();
  let key = "scheduled";
  if (status === "completed") key = "completed";
  else if (status === "cancelled") key = "cancelled";
  else if (status === "no_show" || status === "noshow") key = "no_show";
  else if (isBookingPaidForHubSpot(booking) || status === "confirmed") key = "paid";

  const envKey = {
    scheduled: "HUBSPOT_DEAL_STAGE_SCHEDULED",
    paid: "HUBSPOT_DEAL_STAGE_PAID",
    completed: "HUBSPOT_DEAL_STAGE_COMPLETED",
    cancelled: "HUBSPOT_DEAL_STAGE_CANCELLED",
    no_show: "HUBSPOT_DEAL_STAGE_NO_SHOW",
  }[key];
  const dealstage = String(process.env[envKey] || "").trim() || null;
  const pipelineId = String(process.env.HUBSPOT_DEAL_PIPELINE_ID || "").trim() || null;
  return { key, dealstage, pipelineId };
}

/** Skip unpaid holds — deals start at paid/confirmed (or terminal statuses). */
export function shouldSyncBookingAsDeal(booking) {
  if (!booking?.id) return false;
  const status = String(booking.booking_status || "").toLowerCase();
  if (["completed", "cancelled", "no_show", "noshow", "confirmed"].includes(status)) return true;
  if (isBookingPaidForHubSpot(booking)) return true;
  return false;
}

function bookingAmount(booking) {
  const candidates = [
    booking?.total_price,
    booking?.total_amount,
    booking?.amount_paid,
    booking?.total_paid,
    booking?.amount,
    booking?.service_price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function bookingCloseDate(booking) {
  const datePart = String(booking?.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return new Date().toISOString().slice(0, 10);
  }
  const timePart = String(booking?.time || "12:00").slice(0, 8);
  const iso = `${datePart}T${timePart.length === 5 ? `${timePart}:00` : timePart}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return datePart;
  return d.toISOString();
}

function dealPropertiesFromBooking(booking) {
  const pipeline = resolveHubSpotDealPipeline(booking);
  const service = String(booking?.service || "Appointment").trim() || "Appointment";
  const customer = String(booking?.customer_name || "Customer").trim();
  const datePart = String(booking?.date || "").slice(0, 10);
  const dealname = `${service} — ${customer}${datePart ? ` — ${datePart}` : ""}`.slice(0, 200);
  const props = {
    dealname,
    amount: String(bookingAmount(booking)),
    closedate: bookingCloseDate(booking),
    ifcdc_booking_id: String(booking.id),
    ifcdc_appointment_status: pipeline.key,
    ifcdc_payment_status: String(booking.payment_status || "").slice(0, 64),
  };
  if (booking.barber_id != null) props.ifcdc_barber_id = String(booking.barber_id);
  if (booking.business_id != null) props.ifcdc_business_id = String(booking.business_id);
  if (booking.service) props.ifcdc_service = String(booking.service).slice(0, 256);
  if (pipeline.dealstage) props.dealstage = pipeline.dealstage;
  if (pipeline.pipelineId) props.pipeline = pipeline.pipelineId;

  if (isHubSpotWorkflowSyncEnabled()) {
    if (pipeline.key === "completed" || booking.ifcdc_review_requested === true) {
      props.ifcdc_review_requested = "true";
    }
    if (pipeline.key === "paid" || booking.ifcdc_confirmation_sent === true) {
      props.ifcdc_confirmation_ready = "true";
    }
    if (booking.loyaltyPointsEarned != null && Number.isFinite(Number(booking.loyaltyPointsEarned))) {
      props.ifcdc_loyalty_points_earned = String(Number(booking.loyaltyPointsEarned));
    }
    if (booking.barber_id != null) {
      props.ifcdc_rebook_barber_id = String(booking.barber_id);
    }
  }
  return { props, pipeline };
}

async function findDealIdByBookingId(bookingId) {
  try {
    const mapped = await dbQuery(
      `SELECT hubspot_deal_id FROM hubspot_sync_deals
       WHERE booking_id = $1::uuid AND hubspot_deal_id IS NOT NULL LIMIT 1`,
      [String(bookingId)],
    );
    if (mapped.rows?.[0]?.hubspot_deal_id) {
      return String(mapped.rows[0].hubspot_deal_id);
    }
  } catch {
    // continue
  }

  try {
    const { data } = await hubspotRequest("/crm/v3/objects/deals/search", {
      method: "POST",
      body: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "ifcdc_booking_id",
                operator: "EQ",
                value: String(bookingId),
              },
            ],
          },
        ],
        properties: ["dealname", "ifcdc_booking_id"],
        limit: 1,
      },
    });
    const id = data?.results?.[0]?.id;
    return id ? String(id) : null;
  } catch (error) {
    if (error?.status === 400 || error?.status === 404) return null;
    throw error;
  }
}

function stripCustomDealProps(properties) {
  const keep = ["dealname", "amount", "closedate", "dealstage", "pipeline"];
  const out = {};
  for (const k of keep) {
    if (properties[k] != null && properties[k] !== "") out[k] = properties[k];
  }
  return out;
}

async function createDeal(properties) {
  try {
    const { data } = await hubspotRequest("/crm/v3/objects/deals", {
      method: "POST",
      body: { properties },
    });
    return data?.id ? String(data.id) : null;
  } catch (error) {
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const { data } = await hubspotRequest("/crm/v3/objects/deals", {
        method: "POST",
        body: { properties: stripCustomDealProps(properties) },
      });
      return data?.id ? String(data.id) : null;
    }
    throw error;
  }
}

async function updateDeal(dealId, properties) {
  try {
    const { data } = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      body: { properties },
    });
    return data?.id ? String(data.id) : String(dealId);
  } catch (error) {
    if (error?.status === 400 && /property|doesn|exist|invalid/i.test(String(error?.message || ""))) {
      const { data } = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        body: { properties: stripCustomDealProps(properties) },
      });
      return data?.id ? String(data.id) : String(dealId);
    }
    throw error;
  }
}

/** HubSpot-defined: deal → contact (3), deal → company (5). */
const DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID = 3;
const DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID = 5;

async function associateDealToObject(dealId, toObjectType, toObjectId, associationTypeId) {
  if (!dealId || !toObjectId) return { ok: false, skipped: true };
  try {
    await hubspotRequest(
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/${encodeURIComponent(toObjectType)}/${encodeURIComponent(toObjectId)}`,
      {
        method: "PUT",
        body: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId,
          },
        ],
      },
    );
    return { ok: true };
  } catch (error) {
    if (error?.status === 409) return { ok: true, alreadyAssociated: true };
    console.warn("[hubspot] deal_association_failed", {
      toObjectType,
      message: sanitizeErrorMessage(error),
      status: error?.status || null,
    });
    return { ok: false, message: sanitizeErrorMessage(error) };
  }
}

async function associateDealRelationships(booking, dealId) {
  const result = { contact: false, company: false };
  const email = normalizeEmail(booking?.customer_email);
  if (email) {
    try {
      let contactId = null;
      const mapped = await dbQuery(
        `SELECT hubspot_contact_id FROM hubspot_sync_contacts
         WHERE lower(email) = lower($1) AND hubspot_contact_id IS NOT NULL LIMIT 1`,
        [email],
      ).catch(() => ({ rows: [] }));
      contactId = mapped.rows?.[0]?.hubspot_contact_id || null;
      if (!contactId) {
        contactId = await findContactIdByEmail(email).catch(() => null);
      }
      // Guest checkout may never have synced a contact — upsert from booking email.
      if (!contactId) {
        const name = String(booking?.customer_name || "").trim() || email;
        const sync = await syncContactToHubSpot(
          {
            id: booking?.user_id || null,
            email,
            name,
          },
          { reason: "deal_association_contact_upsert" },
        ).catch(() => null);
        contactId = sync?.hubspotContactId || sync?.contactId || null;
        if (!contactId) {
          contactId = await findContactIdByEmail(email).catch(() => null);
        }
      }
      if (contactId) {
        const assoc = await associateDealToObject(
          dealId,
          "contacts",
          String(contactId),
          DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID,
        );
        result.contact = Boolean(assoc.ok);
      }
    } catch (e) {
      console.warn("[hubspot] deal_contact_link_skipped:", sanitizeErrorMessage(e));
    }
  }

  if (booking?.business_id != null) {
    try {
      const companyMap = await dbQuery(
        `SELECT hubspot_company_id FROM hubspot_sync_companies
         WHERE business_id = $1::bigint AND hubspot_company_id IS NOT NULL LIMIT 1`,
        [Number(booking.business_id)],
      ).catch(() => ({ rows: [] }));
      const companyId = companyMap.rows?.[0]?.hubspot_company_id;
      if (companyId) {
        const assoc = await associateDealToObject(
          dealId,
          "companies",
          String(companyId),
          DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID,
        );
        result.company = Boolean(assoc.ok);
      }
    } catch (e) {
      console.warn("[hubspot] deal_company_link_skipped:", sanitizeErrorMessage(e));
    }
  }
  return result;
}

export async function loadBookingForHubSpot(bookingId) {
  const id = String(bookingId || "").trim();
  if (!id) return null;
  const r = await dbQuery(
    `SELECT id, booking_status, payment_status, is_paid_booking,
            customer_email, customer_name, user_id,
            barber_id, barber_name, business_id,
            service, date, time,
            total_price, total_amount, amount, service_price,
            amount_paid, total_paid, amount_charged, tip_amount, platform_fee
     FROM bookings WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  return r.rows?.[0] || null;
}

/**
 * Upsert a HubSpot Deal for an IFCDC booking (appointment).
 * Idempotent via hubspot_sync_deals + ifcdc_booking_id.
 */
export async function syncDealToHubSpot(booking, { reason = "sync" } = {}) {
  const bookingId = booking?.id ? String(booking.id) : null;
  if (!bookingId) {
    return { ok: false, skipped: true, reason: "missing_booking_id" };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!isHubSpotDealSyncEnabled()) {
    return { ok: false, skipped: true, reason: "deal_sync_disabled" };
  }
  if (!shouldSyncBookingAsDeal(booking)) {
    return { ok: false, skipped: true, reason: "booking_not_eligible" };
  }

  const { props, pipeline } = dealPropertiesFromBooking(booking);

  try {
    let dealId = await findDealIdByBookingId(bookingId);
    let action;
    if (dealId) {
      dealId = await updateDeal(dealId, props);
      action = "deal_updated";
    } else {
      dealId = await createDeal(props);
      action = "deal_created";
      if (!dealId) {
        dealId = await findDealIdByBookingId(bookingId);
        if (dealId) {
          dealId = await updateDeal(dealId, props);
          action = "deal_updated";
        }
      }
    }

    if (!dealId) throw new Error("hubspot_deal_id_missing");

    const associations = await associateDealRelationships(booking, dealId);

    await upsertLocalDealRow({
      bookingId,
      hubspotDealId: dealId,
      status: "synced",
      error: null,
      metadata: { pipeline: pipeline.key, associations, reason },
    });
    await recordEvent({
      entityType: "deal",
      localId: bookingId,
      action,
      status: "ok",
      httpStatus: action === "deal_created" ? 201 : 200,
      message: `${reason}:${pipeline.key}`,
    });

    console.log("[hubspot] deal_sync_ok", {
      action,
      reason,
      pipeline: pipeline.key,
      bookingIdSuffix: bookingId.slice(-6),
      dealIdSuffix: dealId.slice(-6),
    });

    return {
      ok: true,
      action,
      hubspotDealId: dealId,
      pipeline: pipeline.key,
      associations,
      reason,
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await upsertLocalDealRow({
      bookingId,
      status: "error",
      error: message,
    });
    await recordEvent({
      entityType: "deal",
      localId: bookingId,
      action: "deal_sync",
      status: "error",
      httpStatus: error?.status || null,
      message,
    });
    console.warn("[hubspot] deal_sync_failed", {
      reason,
      bookingIdSuffix: bookingId.slice(-6),
      code: error?.code || "error",
      status: error?.status || null,
      message,
    });
    return { ok: false, reason, message };
  }
}

/**
 * Fire-and-forget deal sync by booking id — never throws to the caller.
 */
export function enqueueDealSyncById(bookingId, options = {}) {
  try {
    if (!isHubSpotConfigured() || !isHubSpotDealSyncEnabled()) return;
    const id = String(bookingId || "").trim();
    if (!id) return;
    void (async () => {
      const booking = await loadBookingForHubSpot(id);
      if (!booking) return;
      const merged = {
        ...booking,
        ...(options.dealExtras && typeof options.dealExtras === "object" ? options.dealExtras : {}),
      };
      await syncDealToHubSpot(merged, options);
    })().catch((error) => {
      console.warn("[hubspot] enqueue deal sync error:", sanitizeErrorMessage(error));
    });
  } catch (error) {
    console.warn("[hubspot] enqueue deal failed:", sanitizeErrorMessage(error));
  }
}

/**
 * Admin/ops deal round-trip: sync twice and confirm same HubSpot deal id.
 */
export async function testDealSyncRoundTrip(bookingId) {
  const booking = await loadBookingForHubSpot(bookingId);
  if (!booking) {
    return { ok: false, message: "Booking not found" };
  }
  if (!isHubSpotConfigured()) {
    return { ok: false, message: "HUBSPOT_SERVICE_KEY is not set" };
  }

  const previous = process.env.HUBSPOT_SYNC_DEALS;
  const previousMaster = process.env.HUBSPOT_SYNC_ENABLED;
  process.env.HUBSPOT_SYNC_ENABLED = "1";
  process.env.HUBSPOT_SYNC_DEALS = "1";
  try {
    clearHubSpotClientState();
    // Ensure eligibility for test even if unpaid hold — temporarily treat as confirmed paid.
    const testBooking = {
      ...booking,
      booking_status: booking.booking_status || "confirmed",
      payment_status: booking.payment_status || "paid_in_full",
      is_paid_booking: true,
    };
    const created = await syncDealToHubSpot(testBooking, { reason: "admin_test_deal_create" });
    if (!created.ok) {
      return {
        ok: false,
        step: "create_or_update",
        message: created.message || created.reason || "deal sync failed",
        action: created.action || null,
      };
    }
    const updated = await syncDealToHubSpot(
      { ...testBooking, booking_status: "completed" },
      { reason: "admin_test_deal_update" },
    );
    if (!updated.ok) {
      return {
        ok: false,
        step: "update",
        message: updated.message || updated.reason,
        hubspotDealId: created.hubspotDealId || null,
      };
    }
    const sameId =
      Boolean(created.hubspotDealId)
      && created.hubspotDealId === updated.hubspotDealId;
    return {
      ok: true,
      createAction: created.action,
      updateAction: updated.action,
      hubspotDealId: updated.hubspotDealId,
      duplicatePrevented: sameId,
      pipeline: updated.pipeline || created.pipeline || null,
      associations: updated.associations || created.associations || null,
      message: sameId
        ? "Deal create/update succeeded; booking_id keyed to a single HubSpot deal"
        : "Deal sync succeeded but deal IDs differed between passes",
    };
  } finally {
    if (previous == null) delete process.env.HUBSPOT_SYNC_DEALS;
    else process.env.HUBSPOT_SYNC_DEALS = previous;
    if (previousMaster == null) delete process.env.HUBSPOT_SYNC_ENABLED;
    else process.env.HUBSPOT_SYNC_ENABLED = previousMaster;
  }
}

/** Phase 2 entity types — company = 2A, deal = 2B; remaining planned. */
export const HUBSPOT_FUTURE_ENTITY_TYPES = Object.freeze([
  "company", // barbershops / businesses
  "deal", // appointments / bookings
  "barber",
  "loyalty_points",
  "reward",
  "review",
]);
