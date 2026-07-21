/**
 * Phase 2C HubSpot setup — properties, workflow scaffolds, marketing emails.
 * Runs on the canonical Render service using process.env.HUBSPOT_SERVICE_KEY.
 * Never logs or returns the service key.
 */
import { createHash } from "crypto";
import {
  enqueueCompanySyncById,
  enqueueDealSyncById,
  isHubSpotCompanySyncEnabled,
  isHubSpotConfigured,
  isHubSpotDealSyncEnabled,
  isHubSpotSyncEnabled,
  isHubSpotWorkflowSyncEnabled,
} from "./hubspotService.js";
import { dbQuery } from "./db.js";

const API = "https://api.hubapi.com";

let lastSetupSummary = null;
let setupInFlight = null;
let lastSetupAttemptAt = 0;
const SETUP_RETRY_COOLDOWN_MS = 2 * 60 * 1000;

export function getLastPhase2cSetupSummary() {
  return lastSetupSummary;
}

/**
 * Re-run setup if last attempt failed (e.g. after HubSpot plan upgrade).
 * Rate-limited; never throws to callers.
 */
export function maybeRerunPhase2cSetup({ force = false, enableWorkflows = true } = {}) {
  const now = Date.now();
  const workflows = lastSetupSummary?.workflows || [];
  const workflowOk = workflows.filter((w) => w.status === "exists" || w.status === "created").length;
  const workflowTotal = Math.max(workflows.length, 6);
  const failed =
    !lastSetupSummary ||
    lastSetupSummary.ok !== true ||
    lastSetupSummary.automationProbe?.ok === false ||
    workflowOk < workflowTotal;

  if (!force && !failed) {
    return Promise.resolve(lastSetupSummary);
  }
  if (!force && now - lastSetupAttemptAt < SETUP_RETRY_COOLDOWN_MS) {
    return Promise.resolve(lastSetupSummary);
  }
  if (setupInFlight) return setupInFlight;

  lastSetupAttemptAt = now;
  setupInFlight = ensurePhase2cHubSpotSetup({ enableWorkflows })
    .catch((error) => {
      console.warn("[hubspot] phase2c_setup_retry failed:", error?.message || error);
      return lastSetupSummary;
    })
    .finally(() => {
      setupInFlight = null;
    });
  return setupInFlight;
}

function envFlag(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function getKey() {
  return String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
}

/** Non-secret fingerprint so we can prove which token Render is using. */
function tokenFingerprint(key = getKey()) {
  const s = String(key || "").trim();
  if (!s) return null;
  return {
    sha256_12: createHash("sha256").update(s).digest("hex").slice(0, 12),
    length: s.length,
    prefix: s.slice(0, 7),
    format: s.startsWith("pat-") ? "private_app_pat" : "unknown",
  };
}

async function hs(path, { method = "GET", body, auth = true } = {}) {
  const key = getKey();
  if (auth && !key) {
    const err = new Error("hubspot_not_configured");
    err.code = "hubspot_not_configured";
    throw err;
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (auth) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: String(text || "").slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, json, text: String(text || "").slice(0, 800), path, method };
}

/** Extract actionable HubSpot permission details (never includes tokens). */
function permissionDetails(response) {
  const json = response?.json || {};
  const errors = Array.isArray(json.errors) ? json.errors : [];
  const requiredScopes = [];
  for (const err of errors) {
    const ctx = err?.context || {};
    for (const key of ["requiredGranularScopes", "requiredScopes", "scopes"]) {
      const vals = ctx[key];
      if (Array.isArray(vals)) requiredScopes.push(...vals.map(String));
      else if (typeof vals === "string") requiredScopes.push(vals);
    }
  }
  if (Array.isArray(json.context?.requiredGranularScopes)) {
    requiredScopes.push(...json.context.requiredGranularScopes.map(String));
  }
  if (Array.isArray(json.context?.requiredScopes)) {
    requiredScopes.push(...json.context.requiredScopes.map(String));
  }
  return {
    endpoint: `${response?.method || "GET"} ${response?.path || ""}`.trim(),
    http: response?.status || null,
    category: json.category || null,
    subCategory: json.subCategory || null,
    status: json.status || null,
    message: json.message || response?.text || null,
    correlationId: json.correlationId || null,
    requiredScopes: [...new Set(requiredScopes)],
    errorMessages: errors.map((e) => e?.message).filter(Boolean).slice(0, 5),
    errorContext: errors.map((e) => e?.context || null).filter(Boolean).slice(0, 3),
    hubspotBody: json && typeof json === "object"
      ? {
          status: json.status || null,
          message: json.message || null,
          category: json.category || null,
          subCategory: json.subCategory || null,
          correlationId: json.correlationId || null,
          context: json.context || null,
          errors: Array.isArray(json.errors) ? json.errors.slice(0, 5) : undefined,
        }
      : null,
  };
}

/**
 * Private-app PATs cannot use GET /oauth/v1/access-tokens/:token (always 400).
 * Use POST /oauth/v2/private-apps/get/access-token-info instead.
 */
async function inspectPrivateAppToken() {
  const key = getKey();
  const fingerprint = tokenFingerprint(key);
  const info = await hs("/oauth/v2/private-apps/get/access-token-info", {
    method: "POST",
    body: { tokenKey: key },
  });
  const scopes = Array.isArray(info.json?.scopes) ? info.json.scopes.map(String).sort() : [];
  const hasAutomation = scopes.includes("automation");
  const hasWorkflowsPublicApi = scopes.includes("workflows-access-public-api");
  return {
    ok: info.ok,
    http: info.status,
    endpoint: "POST /oauth/v2/private-apps/get/access-token-info",
    fingerprint,
    hasAutomation,
    hasWorkflowsPublicApi,
    scopes,
    hubId: info.json?.hubId || info.json?.hub_id || null,
    userId: info.json?.userId || info.json?.user_id || null,
    appId: info.json?.appId || info.json?.app_id || null,
    message: info.ok ? null : info.json?.message || info.text || null,
    permission: info.ok ? null : permissionDetails(info),
  };
}

const CONTACT_PROPS = [
  { name: "ifcdc_user_id", label: "IFCDC User ID", type: "string", fieldType: "text", groupName: "contactinformation" },
  { name: "ifcdc_lifecycle_stage", label: "IFCDC Lifecycle Stage", type: "string", fieldType: "text", groupName: "contactinformation" },
  { name: "ifcdc_registered_at", label: "IFCDC Registered At", type: "datetime", fieldType: "date", groupName: "contactinformation" },
  { name: "ifcdc_date_of_birth", label: "IFCDC Date of Birth", type: "date", fieldType: "date", groupName: "contactinformation" },
  { name: "ifcdc_loyalty_points", label: "IFCDC Loyalty Points", type: "number", fieldType: "number", groupName: "contactinformation" },
  { name: "ifcdc_loyalty_lifetime_earned", label: "IFCDC Loyalty Lifetime Earned", type: "number", fieldType: "number", groupName: "contactinformation" },
  { name: "ifcdc_loyalty_completed_haircuts", label: "IFCDC Loyalty Completed Haircuts", type: "number", fieldType: "number", groupName: "contactinformation" },
  { name: "ifcdc_loyalty_last_event", label: "IFCDC Loyalty Last Event", type: "string", fieldType: "text", groupName: "contactinformation" },
  { name: "ifcdc_loyalty_last_reward", label: "IFCDC Loyalty Last Reward", type: "string", fieldType: "text", groupName: "contactinformation" },
  { name: "ifcdc_last_completed_at", label: "IFCDC Last Completed At", type: "datetime", fieldType: "date", groupName: "contactinformation" },
  { name: "ifcdc_preferred_barber_id", label: "IFCDC Preferred Barber ID", type: "string", fieldType: "text", groupName: "contactinformation" },
  { name: "ifcdc_rebook_eligible", label: "IFCDC Rebook Eligible", type: "string", fieldType: "text", groupName: "contactinformation" },
];

const DEAL_PROPS = [
  { name: "ifcdc_appointment_status", label: "IFCDC Appointment Status", type: "string", fieldType: "text", groupName: "dealinformation" },
  { name: "ifcdc_confirmation_ready", label: "IFCDC Confirmation Ready", type: "string", fieldType: "text", groupName: "dealinformation" },
  { name: "ifcdc_review_requested", label: "IFCDC Review Requested", type: "string", fieldType: "text", groupName: "dealinformation" },
  { name: "ifcdc_loyalty_points_earned", label: "IFCDC Loyalty Points Earned", type: "number", fieldType: "number", groupName: "dealinformation" },
  { name: "ifcdc_rebook_barber_id", label: "IFCDC Rebook Barber ID", type: "string", fieldType: "text", groupName: "dealinformation" },
];

const WORKFLOWS = [
  {
    key: "welcome",
    name: "IFCDC — Welcome email",
    emailName: "IFCDC Welcome",
    emailSubject: "Welcome to IFCDC Barbers",
    emailBody:
      "<p>Welcome to IFCDC Barbers. Your account is ready — book your next cut in the app or on the web.</p><p>— IFCDC Barbers</p>",
    type: "CONTACT_FLOW",
    objectTypeId: "0-1",
    delayMinutes: 10,
    enrollmentCriteria: {
      shouldReEnroll: false,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "AND",
          filters: [
            {
              property: "ifcdc_lifecycle_stage",
              operation: { operator: "IS_EQUAL_TO", values: ["registered"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
  {
    key: "confirmation",
    name: "IFCDC — Appointment confirmation",
    emailName: "IFCDC Appointment Confirmation",
    emailSubject: "Your IFCDC appointment is confirmed",
    emailBody:
      "<p>Your appointment is confirmed. See you soon at IFCDC Barbers.</p><p>— IFCDC Barbers</p>",
    type: "PLATFORM_FLOW",
    objectTypeId: "0-3",
    delayMinutes: 1,
    enrollmentCriteria: {
      shouldReEnroll: false,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "OR",
          filters: [
            {
              property: "ifcdc_appointment_status",
              operation: { operator: "IS_EQUAL_TO", values: ["paid"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
            {
              property: "ifcdc_confirmation_ready",
              operation: { operator: "IS_EQUAL_TO", values: ["true"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
  {
    key: "review",
    name: "IFCDC — Review request",
    emailName: "IFCDC Review Request",
    emailSubject: "How was your cut?",
    emailBody:
      "<p>Thanks for visiting IFCDC Barbers. We would love your review in the app.</p><p>— IFCDC Barbers</p>",
    type: "PLATFORM_FLOW",
    objectTypeId: "0-3",
    delayMinutes: 120,
    enrollmentCriteria: {
      shouldReEnroll: false,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "OR",
          filters: [
            {
              property: "ifcdc_appointment_status",
              operation: { operator: "IS_EQUAL_TO", values: ["completed"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
            {
              property: "ifcdc_review_requested",
              operation: { operator: "IS_EQUAL_TO", values: ["true"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
  {
    key: "rebook",
    name: "IFCDC — Rebooking reminder",
    emailName: "IFCDC Rebooking Reminder",
    emailSubject: "Time for a fresh cut?",
    emailBody:
      "<p>It has been a while — book your next IFCDC appointment when you are ready.</p><p>— IFCDC Barbers</p>",
    type: "CONTACT_FLOW",
    objectTypeId: "0-1",
    delayMinutes: 60 * 24 * 21,
    enrollmentCriteria: {
      shouldReEnroll: false,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "OR",
          filters: [
            {
              property: "ifcdc_rebook_eligible",
              operation: { operator: "IS_EQUAL_TO", values: ["true"], operationType: "enumeration" },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
  {
    key: "birthday",
    name: "IFCDC — Birthday promotion",
    emailName: "IFCDC Birthday Promotion",
    emailSubject: "Happy birthday from IFCDC Barbers",
    emailBody:
      "<p>Happy birthday! Treat yourself to a fresh cut at IFCDC Barbers.</p><p>— IFCDC Barbers</p>",
    type: "CONTACT_FLOW",
    objectTypeId: "0-1",
    delayMinutes: 5,
    enrollmentCriteria: {
      shouldReEnroll: true,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "OR",
          filters: [
            {
              property: "ifcdc_date_of_birth",
              operation: { operator: "IS_KNOWN", operationType: "allproperties" },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
  {
    key: "loyalty",
    name: "IFCDC — Loyalty reward notification",
    emailName: "IFCDC Loyalty Reward",
    emailSubject: "Your IFCDC loyalty update",
    emailBody:
      "<p>You earned loyalty progress at IFCDC Barbers. Open the app to view rewards.</p><p>— IFCDC Barbers</p>",
    type: "CONTACT_FLOW",
    objectTypeId: "0-1",
    delayMinutes: 5,
    enrollmentCriteria: {
      shouldReEnroll: true,
      type: "PROPERTY_BASED",
      filterBranches: [
        {
          filterBranchType: "OR",
          filters: [
            {
              property: "ifcdc_loyalty_last_event",
              operation: {
                operator: "IS_EQUAL_TO",
                values: ["earned", "redeemed"],
                operationType: "enumeration",
              },
              filterType: "PROPERTY",
            },
          ],
        },
      ],
    },
  },
];

async function ensureProperty(objectType, prop) {
  const get = await hs(`/crm/v3/properties/${objectType}/${prop.name}`);
  if (get.ok) return { name: prop.name, status: "exists" };
  const created = await hs(`/crm/v3/properties/${objectType}`, {
    method: "POST",
    body: {
      name: prop.name,
      label: prop.label,
      type: prop.type,
      fieldType: prop.fieldType,
      groupName: prop.groupName,
    },
  });
  if (created.ok) return { name: prop.name, status: "created" };
  return {
    name: prop.name,
    status: "error",
    http: created.status,
    message: created.json?.message || created.text,
  };
}

async function findEmailByName(name) {
  const listed = await hs(`/marketing/v3/emails?limit=100&name__eq=${encodeURIComponent(name)}`);
  if (listed.ok && Array.isArray(listed.json?.results)) {
    const exact = listed.json.results.find((e) => String(e.name || "") === name);
    if (exact) return exact;
  }
  // Fallback broader list
  const all = await hs(`/marketing/v3/emails?limit=100`);
  if (all.ok && Array.isArray(all.json?.results)) {
    return all.json.results.find((e) => String(e.name || "") === name) || null;
  }
  return null;
}

async function ensureMarketingEmail(spec) {
  try {
    const existing = await findEmailByName(spec.emailName);
    if (existing?.id) {
      return { name: spec.emailName, status: "exists", id: String(existing.id), state: existing.state || null };
    }
    const created = await hs("/marketing/v3/emails", {
      method: "POST",
      body: {
        name: spec.emailName,
        subject: spec.emailSubject,
        type: "REGULAR",
        subtype: "email",
        isTransactional: true,
        language: "en",
        content: {
          widgets: {
            html_body: {
              html: spec.emailBody,
              css: "",
              body: {},
              type: "html_body",
            },
          },
        },
      },
    });
    if (created.ok && created.json?.id) {
      return {
        name: spec.emailName,
        status: "created",
        id: String(created.json.id),
        state: created.json.state || null,
      };
    }
    return {
      name: spec.emailName,
      status: "error",
      http: created.status,
      message: created.json?.message || created.text,
    };
  } catch (error) {
    return { name: spec.emailName, status: "error", message: String(error?.message || error).slice(0, 180) };
  }
}

function flowCreateBody(spec, emailId) {
  const actions = [
    {
      type: "SINGLE_CONNECTION",
      actionId: "1",
      actionTypeId: "0-3",
      actionTypeVersion: 0,
      fields: {
        delta: String(spec.delayMinutes),
        time_unit: "MINUTES",
      },
    },
  ];
  if (emailId) {
    actions.push({
      type: "SINGLE_CONNECTION",
      actionId: "2",
      actionTypeId: "0-4",
      actionTypeVersion: 0,
      fields: {
        content_id: String(emailId),
      },
    });
  }
  return {
    type: spec.type,
    name: spec.name,
    isEnabled: false,
    flowType: "WORKFLOW",
    objectTypeId: spec.objectTypeId,
    enrollmentCriteria: spec.enrollmentCriteria,
    actions,
  };
}

async function listFlows() {
  const listed = await hs("/automation/v4/flows?limit=100");
  return {
    ok: listed.ok,
    flows: Array.isArray(listed.json?.results) ? listed.json.results : [],
    permission: listed.ok ? null : permissionDetails(listed),
    raw: listed.json,
    http: listed.status,
  };
}

async function probeAutomationSurfaces() {
  const v4 = await hs("/automation/v4/flows?limit=100");
  const v3 = await hs("/automation/v3/workflows");
  return {
    v4Flows: {
      endpoint: "GET /automation/v4/flows?limit=100",
      ok: v4.ok,
      http: v4.status,
      flowCount: Array.isArray(v4.json?.results) ? v4.json.results.length : 0,
      permission: v4.ok ? null : permissionDetails(v4),
      hubspotBody: v4.ok
        ? { resultCount: Array.isArray(v4.json?.results) ? v4.json.results.length : 0 }
        : permissionDetails(v4).hubspotBody,
    },
    v3Workflows: {
      endpoint: "GET /automation/v3/workflows",
      ok: v3.ok,
      http: v3.status,
      workflowCount: Array.isArray(v3.json?.workflows) ? v3.json.workflows.length : null,
      permission: v3.ok ? null : permissionDetails(v3),
      hubspotBody: v3.ok
        ? { workflowCount: Array.isArray(v3.json?.workflows) ? v3.json.workflows.length : null }
        : permissionDetails(v3).hubspotBody,
    },
  };
}

/**
 * Ensure Phase 2C properties, emails, and workflows exist.
 * @param {{ enableWorkflows?: boolean }} [options]
 */
export async function ensurePhase2cHubSpotSetup({ enableWorkflows = false } = {}) {
  const summary = {
    ok: false,
    ranAt: new Date().toISOString(),
    configured: isHubSpotConfigured(),
    workflowSyncEnabled: isHubSpotWorkflowSyncEnabled(),
    serviceKey: isHubSpotConfigured() ? "configured" : "missing",
    tokenFingerprint: tokenFingerprint(),
    properties: [],
    emails: [],
    workflows: [],
    automationProbe: null,
    automationSurfaces: null,
    tokenScopes: null,
    notes: [],
  };

  if (!isHubSpotConfigured()) {
    summary.notes.push("HUBSPOT_SERVICE_KEY missing");
    lastSetupSummary = summary;
    return summary;
  }

  try {
    const me = await hs("/integrations/v1/me");
    if (!me.ok) {
      summary.notes.push(`auth_failed:${me.status}`);
      summary.authPermission = permissionDetails(me);
      lastSetupSummary = summary;
      return summary;
    }
    summary.portalId = me.json?.portalId || me.json?.hub_id || null;

    // Inspect scopes on the live private-app token (never return the token itself).
    try {
      summary.tokenScopes = await inspectPrivateAppToken();
      if (summary.tokenScopes.ok && !summary.tokenScopes.hasAutomation) {
        summary.notes.push(
          "Live HUBSPOT_SERVICE_KEY scopes from POST /oauth/v2/private-apps/get/access-token-info do NOT include automation. Enable automation on that private app, then rotate/copy the token into Render HUBSPOT_SERVICE_KEY and redeploy.",
        );
      } else if (summary.tokenScopes.ok && summary.tokenScopes.hasAutomation) {
        summary.notes.push(
          "Live token DOES include automation scope. If Automation API still 403s, HubSpot is denying Workflows API access for this portal (plan/feature entitlement), not a missing private-app checkbox.",
        );
      } else if (!summary.tokenScopes.ok) {
        summary.notes.push(
          `Private-app token info failed (http ${summary.tokenScopes.http}): ${summary.tokenScopes.message || "unknown"}. Falling back to Automation API probe.`,
        );
      }
    } catch (scopeErr) {
      summary.tokenScopes = {
        ok: false,
        http: null,
        hasAutomation: false,
        scopes: [],
        fingerprint: tokenFingerprint(),
        message: String(scopeErr?.message || scopeErr).slice(0, 120),
      };
    }

    for (const prop of CONTACT_PROPS) {
      summary.properties.push({ object: "contacts", ...(await ensureProperty("contacts", prop)) });
    }
    for (const prop of DEAL_PROPS) {
      summary.properties.push({ object: "deals", ...(await ensureProperty("deals", prop)) });
    }

    const emailByKey = new Map();
    for (const spec of WORKFLOWS) {
      const email = await ensureMarketingEmail(spec);
      summary.emails.push(email);
      if (email.id) emailByKey.set(spec.key, email.id);
    }

    summary.automationSurfaces = await probeAutomationSurfaces();
    const listed = await listFlows();
    summary.automationProbe = {
      endpoint: "GET /automation/v4/flows",
      ok: listed.ok,
      http: listed.http,
      flowCount: listed.flows.length,
      permission: listed.permission,
      hubspotBody: listed.ok
        ? { resultCount: listed.flows.length }
        : listed.permission?.hubspotBody || null,
    };
    if (!listed.ok) {
      const scopesOk = summary.tokenScopes?.ok === true;
      const hasAuto = summary.tokenScopes?.hasAutomation === true;
      if (scopesOk && hasAuto) {
        summary.notes.push(
          "Automation API list failed despite automation scope on the live token — likely portal Workflows feature entitlement / plan, not Render env. Create the six IFCDC workflows in HubSpot UI using the created emails, or open a HubSpot support ticket with the correlationId.",
        );
      } else if (scopesOk && !hasAuto) {
        summary.notes.push(
          "Automation API list failed because the live private-app token scopes omit automation (confirmed via access-token-info).",
        );
      } else {
        summary.notes.push(
          "Workflows API list failed — confirm private app automation scope and that the portal plan includes Workflows. If scopes are correct, create the six IFCDC workflows in HubSpot UI using the created emails.",
        );
      }
    }
    const byName = new Map(listed.flows.map((f) => [String(f.name || ""), f]));

    for (const spec of WORKFLOWS) {
      const emailId = emailByKey.get(spec.key) || null;
      let flow = byName.get(spec.name);
      if (!flow) {
        const created = await hs("/automation/v4/flows", {
          method: "POST",
          body: flowCreateBody(spec, emailId),
        });
        if (created.ok) {
          flow = created.json;
          summary.workflows.push({
            name: spec.name,
            status: "created",
            id: flow?.id || null,
            enabled: flow?.isEnabled === true,
            emailId,
          });
        } else {
          const perm = permissionDetails(created);
          summary.workflows.push({
            name: spec.name,
            status: "error",
            http: created.status,
            message: perm.message,
            emailId,
            endpoint: perm.endpoint,
            category: perm.category,
            subCategory: perm.subCategory,
            requiredScopes: perm.requiredScopes,
            correlationId: perm.correlationId,
            errorMessages: perm.errorMessages,
            hubspotBody: perm.hubspotBody,
          });
          continue;
        }
      } else {
        summary.workflows.push({
          name: spec.name,
          status: "exists",
          id: flow.id,
          enabled: flow.isEnabled === true,
          emailId,
        });
      }

      const shouldEnable = enableWorkflows || envFlag("HUBSPOT_ENABLE_WORKFLOWS");
      if (shouldEnable && flow?.id && emailId && flow.isEnabled !== true) {
        const enabled = await hs(`/automation/v4/flows/${encodeURIComponent(flow.id)}`, {
          method: "PATCH",
          body: { isEnabled: true },
        });
        const row = summary.workflows[summary.workflows.length - 1];
        if (enabled.ok) {
          row.enabled = true;
          row.enableStatus = "enabled";
        } else {
          row.enableStatus = "enable_failed";
          row.enableHttp = enabled.status;
          row.enableMessage = enabled.json?.message || enabled.text;
          row.enableHubspotBody = permissionDetails(enabled).hubspotBody;
        }
      } else if (shouldEnable && !emailId) {
        const row = summary.workflows[summary.workflows.length - 1];
        row.enableStatus = "skipped_no_email";
        summary.notes.push(`${spec.key}: email missing — left disabled`);
      }
    }

    summary.ok =
      summary.properties.every((p) => p.status === "exists" || p.status === "created") &&
      summary.workflows.every((w) => w.status === "exists" || w.status === "created");
  } catch (error) {
    summary.notes.push(String(error?.message || error).slice(0, 180));
  }

  lastSetupSummary = summary;
  return summary;
}

/**
 * Safe controlled mapping backfill (limited, fire-and-forget). Never touches booking/payment paths.
 */
export async function runSafeHubSpotMappingBackfill({ limit = 25 } = {}) {
  const out = {
    ok: true,
    ranAt: new Date().toISOString(),
    skipped: false,
    queuedCompanies: 0,
    queuedDeals: 0,
    reason: null,
  };
  if (!isHubSpotConfigured() || !isHubSpotSyncEnabled()) {
    out.skipped = true;
    out.reason = "hubspot_sync_disabled";
    return out;
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 50);

  if (isHubSpotCompanySyncEnabled()) {
    const rows = await dbQuery(
      `SELECT b.id
       FROM businesses b
       LEFT JOIN hubspot_sync_companies m ON m.business_id = b.id
       WHERE m.business_id IS NULL
          OR m.hubspot_company_id IS NULL
          OR m.last_sync_status IS DISTINCT FROM 'synced'
       ORDER BY b.id ASC
       LIMIT $1`,
      [safeLimit],
    );
    for (const row of rows.rows || []) {
      enqueueCompanySyncById(row.id, { reason: "safe_boot_backfill" });
      out.queuedCompanies += 1;
    }
  }

  if (isHubSpotDealSyncEnabled()) {
    const rows = await dbQuery(
      `SELECT b.id::text AS id
       FROM bookings b
       LEFT JOIN hubspot_sync_deals m ON m.booking_id = b.id
       WHERE (
         b.is_paid_booking = true
         OR lower(coalesce(b.payment_status, '')) IN ('paid', 'paid_full', 'paid_in_full', 'captured', 'deposit_paid')
         OR lower(coalesce(b.booking_status, '')) IN ('completed', 'cancelled', 'no_show', 'confirmed')
       )
         AND lower(coalesce(b.booking_status, '')) IS DISTINCT FROM 'pending_payment'
         AND (
           m.booking_id IS NULL
           OR m.hubspot_deal_id IS NULL
           OR m.last_sync_status IS DISTINCT FROM 'synced'
         )
       ORDER BY coalesce(b.completed_at, b.created_at) DESC NULLS LAST
       LIMIT $1`,
      [safeLimit],
    );
    for (const row of rows.rows || []) {
      enqueueDealSyncById(row.id, { reason: "safe_boot_backfill" });
      out.queuedDeals += 1;
    }
  }

  return out;
}
