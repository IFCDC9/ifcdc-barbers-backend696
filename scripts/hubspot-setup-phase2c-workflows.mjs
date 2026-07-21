#!/usr/bin/env node
/**
 * Phase 2C HubSpot setup: ensure custom properties exist and create/verify
 * the six IFCDC workflow scaffolds (enrollment + delay). Marketing email
 * content must be attached in the HubSpot UI.
 *
 * Usage (canonical key from Render env — do not paste into chat):
 *   HUBSPOT_SERVICE_KEY=... node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs
 *   HUBSPOT_SERVICE_KEY=... node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs --apply
 */
const KEY = String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
const APPLY = process.argv.includes("--apply");
const API = "https://api.hubapi.com";

if (!KEY) {
  console.error(
    "Missing HUBSPOT_SERVICE_KEY.\n" +
      "Copy it from Render → ifcdc-barbers-backend696 → Environment into your local shell, then re-run.\n" +
      "Do not paste the key into chat.",
  );
  process.exit(1);
}

async function hs(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
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
    json = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, json, text };
}

const CONTACT_PROPS = [
  { name: "ifcdc_user_id", label: "IFCDC User ID", type: "string", fieldType: "text" },
  { name: "ifcdc_lifecycle_stage", label: "IFCDC Lifecycle Stage", type: "string", fieldType: "text" },
  { name: "ifcdc_registered_at", label: "IFCDC Registered At", type: "datetime", fieldType: "date" },
  { name: "ifcdc_date_of_birth", label: "IFCDC Date of Birth", type: "date", fieldType: "date" },
  { name: "ifcdc_loyalty_points", label: "IFCDC Loyalty Points", type: "number", fieldType: "number" },
  {
    name: "ifcdc_loyalty_lifetime_earned",
    label: "IFCDC Loyalty Lifetime Earned",
    type: "number",
    fieldType: "number",
  },
  {
    name: "ifcdc_loyalty_completed_haircuts",
    label: "IFCDC Loyalty Completed Haircuts",
    type: "number",
    fieldType: "number",
  },
  { name: "ifcdc_loyalty_last_event", label: "IFCDC Loyalty Last Event", type: "string", fieldType: "text" },
  { name: "ifcdc_loyalty_last_reward", label: "IFCDC Loyalty Last Reward", type: "string", fieldType: "text" },
  { name: "ifcdc_last_completed_at", label: "IFCDC Last Completed At", type: "datetime", fieldType: "date" },
  { name: "ifcdc_preferred_barber_id", label: "IFCDC Preferred Barber ID", type: "string", fieldType: "text" },
  { name: "ifcdc_rebook_eligible", label: "IFCDC Rebook Eligible", type: "string", fieldType: "text" },
];

const DEAL_PROPS = [
  { name: "ifcdc_appointment_status", label: "IFCDC Appointment Status", type: "string", fieldType: "text" },
  { name: "ifcdc_confirmation_ready", label: "IFCDC Confirmation Ready", type: "string", fieldType: "text" },
  { name: "ifcdc_review_requested", label: "IFCDC Review Requested", type: "string", fieldType: "text" },
  {
    name: "ifcdc_loyalty_points_earned",
    label: "IFCDC Loyalty Points Earned",
    type: "number",
    fieldType: "number",
  },
  { name: "ifcdc_rebook_barber_id", label: "IFCDC Rebook Barber ID", type: "string", fieldType: "text" },
];

const WORKFLOWS = [
  {
    key: "welcome",
    name: "IFCDC — Welcome email",
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
            {
              property: "date_of_birth",
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

function flowBody(spec) {
  return {
    type: spec.type,
    name: spec.name,
    isEnabled: false,
    flowType: "WORKFLOW",
    objectTypeId: spec.objectTypeId,
    enrollmentCriteria: spec.enrollmentCriteria,
    actions: [
      {
        type: "SINGLE_CONNECTION",
        actionId: "1",
        actionTypeId: "0-1",
        actionTypeVersion: 0,
        connection: { edgeType: true },
      },
      {
        type: "SINGLE_CONNECTION",
        actionId: "2",
        actionTypeId: "0-3",
        actionTypeVersion: 0,
        fields: {
          delta: String(spec.delayMinutes),
          time_unit: "MINUTES",
        },
      },
    ],
  };
}

async function ensureProperty(objectType, prop) {
  const get = await hs(`/crm/v3/properties/${objectType}/${prop.name}`);
  if (get.ok) return { name: prop.name, status: "exists" };
  if (!APPLY) return { name: prop.name, status: "missing" };
  const created = await hs(`/crm/v3/properties/${objectType}`, {
    method: "POST",
    body: {
      name: prop.name,
      label: prop.label,
      type: prop.type,
      fieldType: prop.fieldType,
      groupName: objectType === "contacts" ? "contactinformation" : "dealinformation",
    },
  });
  if (created.ok) return { name: prop.name, status: "created" };
  return {
    name: prop.name,
    status: "error",
    http: created.status,
    message: created.json?.message || created.text?.slice(0, 180),
  };
}

console.log(`\n=== HubSpot Phase 2C setup (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`);

const auth = await hs("/integrations/v1/me");
if (!auth.ok) {
  console.error("HubSpot auth failed:", auth.status, auth.json?.message || auth.text?.slice(0, 200));
  process.exit(1);
}
console.log("portalId:", auth.json?.portalId || auth.json?.hub_id || "(ok)");

const propResults = [];
for (const prop of CONTACT_PROPS) propResults.push({ object: "contacts", ...(await ensureProperty("contacts", prop)) });
for (const prop of DEAL_PROPS) propResults.push({ object: "deals", ...(await ensureProperty("deals", prop)) });
console.log("\nproperties:");
for (const row of propResults) console.log(" ", row);

const listed = await hs("/automation/v4/flows?limit=100");
const existing = Array.isArray(listed.json?.results) ? listed.json.results : [];
const byName = new Map(existing.map((f) => [String(f.name || ""), f]));

console.log("\nworkflows:");
const workflowResults = [];
for (const spec of WORKFLOWS) {
  const found = byName.get(spec.name);
  if (found) {
    workflowResults.push({ name: spec.name, status: "exists", id: found.id, enabled: found.isEnabled });
    continue;
  }
  if (!APPLY) {
    workflowResults.push({ name: spec.name, status: "missing" });
    continue;
  }
  const created = await hs("/automation/v4/flows", { method: "POST", body: flowBody(spec) });
  if (created.ok) {
    workflowResults.push({
      name: spec.name,
      status: "created",
      id: created.json?.id,
      enabled: created.json?.isEnabled === true,
    });
  } else {
    workflowResults.push({
      name: spec.name,
      status: "error",
      http: created.status,
      message: created.json?.message || created.text?.slice(0, 240),
    });
  }
}
for (const row of workflowResults) console.log(" ", row);

console.log(
  "\nNext: In HubSpot UI, attach Marketing emails to each IFCDC workflow and enable them.\n" +
    "Scaffolds are created disabled so no customer mail sends until copy is reviewed.\n",
);

if (!APPLY) console.log("Dry run only. Re-run with --apply to create missing properties/workflows.\n");
