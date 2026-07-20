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

/** Feature flag — sync is a no-op when disabled. */
export function isHubSpotSyncEnabled() {
  return envFlag("HUBSPOT_SYNC_ENABLED");
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
  return props;
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
    throw error;
  }
}

async function updateContact(contactId, properties) {
  const { data } = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: { properties },
  });
  return data?.id ? String(data.id) : String(contactId);
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

  const properties = contactPropertiesFromUser({ ...user, email });

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

/** Phase 2 stubs — exported so HQ can discover planned entity types. */
export const HUBSPOT_FUTURE_ENTITY_TYPES = Object.freeze([
  "company", // barbershops / businesses
  "deal", // appointments / bookings
  "barber",
  "loyalty_points",
  "reward",
  "review",
]);
