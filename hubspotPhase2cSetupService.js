/**
 * Phase 2C HubSpot setup — properties, workflow scaffolds, marketing emails.
 * Runs on the canonical Render service using process.env.HUBSPOT_SERVICE_KEY.
 * Never logs or returns the service key.
 */
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

export function getLastPhase2cSetupSummary() {
  return lastSetupSummary;
}

function envFlag(name) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function getKey() {
  return String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
}

async function hs(path, { method = "GET", body } = {}) {
  const key = getKey();
  if (!key) {
    const err = new Error("hubspot_not_configured");
    err.code = "hubspot_not_configured";
    throw err;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: String(text || "").slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, json, text: String(text || "").slice(0, 400) };
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
  return Array.isArray(listed.json?.results) ? listed.json.results : [];
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
    properties: [],
    emails: [],
    workflows: [],
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
      lastSetupSummary = summary;
      return summary;
    }
    summary.portalId = me.json?.portalId || me.json?.hub_id || null;

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

    const existing = await listFlows();
    const byName = new Map(existing.map((f) => [String(f.name || ""), f]));

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
          summary.workflows.push({
            name: spec.name,
            status: "error",
            http: created.status,
            message: created.json?.message || created.text,
            emailId,
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
