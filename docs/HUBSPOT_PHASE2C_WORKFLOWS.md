# HubSpot Phase 2C — Workflow Setup Guide

IFCDC sets CRM properties asynchronously. **Emails and delays live in HubSpot Workflows** (Marketing Hub). Node never sends marketing campaign emails for these flows.

## Enable on Render (canonical only)

On `ifcdc-barbers-backend696`:

```
HUBSPOT_SYNC_ENABLED=1
HUBSPOT_SYNC_WORKFLOWS=1
```

Recommended with 2A/2B:

```
HUBSPOT_SYNC_COMPANIES=1
HUBSPOT_SYNC_DEALS=1
```

## Custom properties to create in HubSpot

### Contact

| Internal name | Type | Used by |
|---------------|------|---------|
| `ifcdc_user_id` | Single-line text | Support / dedupe |
| `ifcdc_lifecycle_stage` | Single-line text / dropdown | Welcome (`registered`) |
| `ifcdc_registered_at` | DateTime | Welcome delay |
| `ifcdc_date_of_birth` | Date | Birthday (also syncs HubSpot `date_of_birth` when present) |
| `ifcdc_loyalty_points` | Number | Loyalty threshold emails |
| `ifcdc_loyalty_lifetime_earned` | Number | Engagement |
| `ifcdc_loyalty_completed_haircuts` | Number | VIP / rebook |
| `ifcdc_loyalty_last_event` | Dropdown: `earned`, `redeemed`, `adjusted` | Loyalty notify |
| `ifcdc_loyalty_last_reward` | Single-line text | Reward title/id |
| `ifcdc_last_completed_at` | DateTime | Rebooking delay |
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

If a property is missing, IFCDC falls back to standard HubSpot fields and continues syncing (no booking/payment impact).

## HubSpot private app scopes required for automated setup

In HubSpot → Settings → Integrations → Private Apps → IFCDC app, enable:

- `crm.schemas.contacts.read` / `crm.schemas.contacts.write`
- `crm.schemas.deals.read` / `crm.schemas.deals.write`
- `crm.objects.contacts.read` / `crm.objects.contacts.write`
- `crm.objects.deals.read` / `crm.objects.deals.write`
- `crm.objects.companies.read` / `crm.objects.companies.write`
- `automation` (workflows)
- Marketing email / content scopes needed to create and send the six IFCDC emails

Without schema/automation/marketing scopes, CRM object sync still works; boot setup will report errors on `/api/hubspot/status` → `phase2cSetup.errorSamples`.

## Workflow recipes (create in HubSpot UI)

Prefer the automated scaffold script (creates properties + disabled workflow shells):

```bash
HUBSPOT_SERVICE_KEY=… node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs
HUBSPOT_SERVICE_KEY=… node --import ./loadBackendEnv.mjs scripts/hubspot-setup-phase2c-workflows.mjs --apply
```

Then attach Marketing email content in HubSpot and enable each workflow.

### 1. Welcome email
- **Enrollment:** Contact is created **OR** `ifcdc_lifecycle_stage` is known `registered`
- **Filter:** email is known
- **Actions:** Send welcome email; optional delay 5–15 minutes
- **Backend source:** registration / Google / Apple signup contact sync

### 2. Appointment confirmation
- **Enrollment:** Deal property `ifcdc_appointment_status` is known `paid` **OR** `ifcdc_confirmation_ready` is known `true`
- **Actions:** Send confirmation with deal `dealname`, `closedate`, `amount`
- **Backend source:** PayPal finalize / web paid book deal sync

### 3. Review request
- **Enrollment:** Deal `ifcdc_appointment_status` is known `completed` **OR** `ifcdc_review_requested` is known `true`
- **Delay:** 2–24 hours (ops preference)
- **Actions:** Email/SMS with review CTA (IFCDC review URL)
- **Backend source:** appointment completion side effects

### 4. Rebooking reminder
- **Enrollment:** Contact `ifcdc_last_completed_at` is known **OR** `ifcdc_rebook_eligible` is known `true`
- **Delay:** N days (e.g. 21–28)
- **Actions:** Rebook CTA; personalize with `ifcdc_preferred_barber_id` / `ifcdc_rebook_barber_id`
- **Backend source:** same completion path as review

### 5. Birthday promotions
- **Enrollment:** Contact birthday / `date_of_birth` / `ifcdc_date_of_birth` anniversary
- **Actions:** Birthday offer email
- **Backend source:** optional `PATCH /api/auth/profile` with `{ "dateOfBirth": "YYYY-MM-DD" }` then contact sync  
  (Birthday is optional — not required at signup.)

### 6. Loyalty reward notifications
- **Enrollment options:**
  - `ifcdc_loyalty_last_event` is known `earned` or `redeemed`
  - **OR** `ifcdc_loyalty_points` is greater than or equal to reward thresholds (25 / 50 / 75 / …)
- **Actions:** Congrats + redeem/book CTA
- **Backend source:** completion → loyalty award → contact workflow refresh

## Isolation guarantees

- All property writes are fire-and-forget.
- Feature-flagged: `HUBSPOT_SYNC_WORKFLOWS` off ⇒ no workflow custom props (Phase 1 contact fields still work).
- Failures never block registration, booking, PayPal, loyalty, or completion.
- Canonical Render service only.

## Verify

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/hubspot/status
# expect workflowSyncEnabled: true after flag is set
```
