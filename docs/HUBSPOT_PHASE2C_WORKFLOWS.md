# HubSpot Phase 2C — Starter-compatible setup

IFCDC targets **HubSpot Starter** by default.

| Layer | Starter (current) | Professional+ (optional) |
|-------|-------------------|---------------------------|
| Contacts / companies / deals sync | Yes | Yes |
| Custom CRM properties | Yes (API) | Yes |
| Marketing emails (6 IFCDC templates) | Yes (API) | Yes |
| Forms | Use HubSpot UI forms if needed | Same |
| Workflow enrollment automations | **HubSpot UI / Simple automation** (manual) | Workflows API `/automation/v4/flows` |
| Backend property enrichment (`HUBSPOT_SYNC_WORKFLOWS`) | Yes — writes enrollment props only | Same |

Node **never** sends marketing campaign emails. On Starter, email send/delay lives in HubSpot’s supported UI automations attached to the emails we create.

## Enable on Render (canonical only)

```
HUBSPOT_SYNC_ENABLED=1
HUBSPOT_SYNC_COMPANIES=1
HUBSPOT_SYNC_DEALS=1
HUBSPOT_SYNC_WORKFLOWS=1
```

`HUBSPOT_SYNC_WORKFLOWS` means **sync workflow enrollment properties** to contacts/deals. It does **not** require the Professional Workflows API.

## Private app scopes (Starter)

- `crm.schemas.contacts.read` / `crm.schemas.contacts.write`
- `crm.schemas.deals.read` / `crm.schemas.deals.write`
- `crm.objects.contacts.read` / `crm.objects.contacts.write`
- `crm.objects.deals.read` / `crm.objects.deals.write`
- `crm.objects.companies.read` / `crm.objects.companies.write`
- `content` (marketing email create/update)

`automation` is **optional** and only useful on Professional+. Setup succeeds without it.

## Professional-only blocker (exact)

If the portal is Starter, these endpoints fail and setup **falls back** (does not fail):

| Endpoint | Typical response | Requires |
|----------|------------------|----------|
| `GET /automation/v4/flows` | **403** `MISSING_SCOPES` / `automation` (often misleading) | Marketing Hub **Professional+** Workflows API |
| `POST /automation/v4/flows` | **403** | same |
| `GET /automation/v3/workflows` | **403** `EXTERNAL auth request is missing required 'workflows-access-public-api' scope.` | same |

Live status exposes this under `phase2cSetup.professionalBlocker` + `subscriptionMode: "starter"`.

**Compelling reason to upgrade to Professional:** only if you need API-managed workflow create/enable at scale. For IFCDC’s six emails, HubSpot UI automations on Starter are enough.

## Custom properties

### Contact

| Internal name | Type | Used by |
|---------------|------|---------|
| `ifcdc_user_id` | Single-line text | Support / dedupe |
| `ifcdc_lifecycle_stage` | Single-line text / dropdown | Welcome (`registered`) |
| `ifcdc_registered_at` | DateTime | Welcome timing |
| `ifcdc_date_of_birth` | Date | Birthday (also syncs HubSpot `date_of_birth` when present) |
| `ifcdc_loyalty_points` | Number | Loyalty threshold emails |
| `ifcdc_loyalty_lifetime_earned` | Number | Engagement |
| `ifcdc_loyalty_completed_haircuts` | Number | VIP / rebook |
| `ifcdc_loyalty_last_event` | Dropdown: `earned`, `redeemed`, `adjusted` | Loyalty notify |
| `ifcdc_loyalty_last_reward` | Single-line text | Reward title/id |
| `ifcdc_last_completed_at` | DateTime | Rebooking timing |
| `ifcdc_preferred_barber_id` | Single-line text | Personalization |
| `ifcdc_rebook_eligible` | Single checkbox / text `true` | Rebook enrollment |

### Deal

| Internal name | Type | Used by |
|---------------|------|---------|
| `ifcdc_appointment_status` | text: `paid` / `completed` / `cancelled` / `no_show` | Confirmation, review, cancel |
| `ifcdc_confirmation_ready` | text `true` | Appointment confirmation |
| `ifcdc_review_requested` | text `true` | Review request |
| `ifcdc_loyalty_points_earned` | Number | Optional copy in review email |
| `ifcdc_rebook_barber_id` | text | Rebook deep link |

## Starter fallback — create automations in HubSpot UI

Setup creates these marketing emails automatically (when `content` scope is present):

1. `IFCDC Welcome`
2. `IFCDC Appointment Confirmation`
3. `IFCDC Review Request`
4. `IFCDC Rebooking Reminder`
5. `IFCDC Birthday`
6. `IFCDC Loyalty Reward`

Then in HubSpot UI (Starter-supported Simple automation / email tools), wire each:

### 1. Welcome email
- **Enrollment:** Contact created **OR** `ifcdc_lifecycle_stage` is `registered`
- **Actions:** Send `IFCDC Welcome` (optional short delay)

### 2. Appointment confirmation
- **Enrollment:** Deal `ifcdc_appointment_status` is `paid` **OR** `ifcdc_confirmation_ready` is `true`
- **Actions:** Send `IFCDC Appointment Confirmation`

### 3. Review request
- **Enrollment:** Deal `ifcdc_appointment_status` is `completed` **OR** `ifcdc_review_requested` is `true`
- **Delay:** 2–24 hours
- **Actions:** Send `IFCDC Review Request`

### 4. Rebooking reminder
- **Enrollment:** Contact `ifcdc_last_completed_at` known **OR** `ifcdc_rebook_eligible` is `true`
- **Delay:** e.g. 21–28 days
- **Actions:** Send `IFCDC Rebooking Reminder`

### 5. Birthday promotions
- **Enrollment:** Contact birthday / `date_of_birth` / `ifcdc_date_of_birth`
- **Actions:** Send `IFCDC Birthday`

### 6. Loyalty reward notifications
- **Enrollment:** `ifcdc_loyalty_last_event` is `earned`/`redeemed` **OR** points thresholds
- **Actions:** Send `IFCDC Loyalty Reward`

## Verify

```bash
curl -sS 'https://ifcdc-barbers-backend696.onrender.com/api/hubspot/status?refreshSetup=1'
# then:
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/hubspot/status \
  | jq '.phase2cSetup | {ok,subscriptionMode,workflowProvisionMode,propertyOk,emailOk,workflowOk,professionalBlocker}'
```

Expect on Starter:

- `ok: true`
- `subscriptionMode: "starter"`
- `workflowProvisionMode: "starter_manual"`
- `propertyOk` / `emailOk` complete
- `professionalBlocker` documenting the Pro-only endpoints (informational)

## Isolation guarantees

- All property writes are fire-and-forget.
- Feature-flagged: `HUBSPOT_SYNC_WORKFLOWS` off ⇒ no workflow custom props (Phase 1 contact fields still work).
- Failures never block registration, booking, PayPal, loyalty, or completion.
- Canonical Render service only.
- Starter setup **does not fail** when Workflows API returns 403.
