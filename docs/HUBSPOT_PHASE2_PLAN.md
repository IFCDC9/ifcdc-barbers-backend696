# HubSpot Phase 2 — Implementation Plan

**Status:** Phase 2A–2D implemented (enable via Render flags).

### Phase 2D shipped (code)
- Feature flag: `HUBSPOT_HQ_ANALYTICS`
- `GET /api/admin/hubspot/kpis?days=30` — growth, returning rate, volume, revenue, top barbers/shops, CLV, marketing signals, sync health
- HQ UI: web Admin “HubSpot & CRM analytics” + mobile Platform analytics
- Docs: property/workflow guide remains in `docs/HUBSPOT_PHASE2C_WORKFLOWS.md`

### Phase 2C shipped (code)
- Feature flag: `HUBSPOT_SYNC_WORKFLOWS`
- Contact enrichment: lifecycle/welcome, loyalty, birthday, rebook eligibility
- Deal enrichment: confirmation ready, review requested, loyalty points earned
- Hooks: registration lifecycle, completion → deal + contact refresh, paid finalize confirmation
- Optional `date_of_birth` on `app_users` + profile PATCH
- Ops guide: `docs/HUBSPOT_PHASE2C_WORKFLOWS.md`

### Phase 2B shipped (code)
- Feature flag: `HUBSPOT_SYNC_DEALS` (requires `HUBSPOT_SYNC_ENABLED` + canonical runtime)
- `syncDealToHubSpot` / `enqueueDealSyncById` with duplicate prevention via mapping + `ifcdc_booking_id`
- Pipeline keys: `scheduled` | `paid` | `completed` | `cancelled` | `no_show` (+ optional HubSpot stage IDs via env)
- Skips unpaid `pending_payment` holds (avoids deal spam)
- Associations: deal ↔ contact, deal ↔ company when mappings exist
- Hooks: PayPal finalize, web `/api/book`, completion side effects, cancel, no-show status
- Admin: `POST /api/hubspot/test-deal`
- Enable on Render: set `HUBSPOT_SYNC_DEALS=1` on **only** `ifcdc-barbers-backend696`

### Phase 2A shipped (code)
- Feature flag: `HUBSPOT_SYNC_COMPANIES` (requires `HUBSPOT_SYNC_ENABLED` + canonical runtime)
- `syncCompanyToHubSpot` / `enqueueCompanySyncById` with duplicate prevention via mapping + `ifcdc_business_id`
- Contact ↔ company associations for shop owners/barbers
- Hooks: barber/shop-owner signup, onboarding, admin shop update/approve/reject/status, barber profile + shop detail
- Admin: `POST /api/hubspot/test-company`
- Enable on Render: set `HUBSPOT_SYNC_COMPANIES=1` on **only** `ifcdc-barbers-backend696`

---

## 1. Goals

| Objective | HubSpot object | Local source of truth |
|-----------|----------------|------------------------|
| Sync barbershops | **Companies** | `businesses` (+ shop profile fields) |
| Sync appointments | **Deals** | `bookings` / app-booking rows |
| Automate lifecycle | HubSpot **Workflows** | Triggers from deal/contact properties + IFCDC webhooks where needed |
| HQ analytics | HubSpot reporting + IFCDC HQ UI | Aggregates from HubSpot APIs + local KPIs |
| Compatibility | — | No breaking changes to register, book, PayPal, loyalty, completion |

Phase 2 stays behind `HUBSPOT_SYNC_ENABLED` and the **canonical-runtime guard** (Phase 1 hardening). Failures remain fire-and-forget — never block booking/payment/auth.

---

## 2. Non-goals (explicit)

- Replacing IFCDC booking/payment engines with HubSpot
- Two-way overwrite of local booking state from HubSpot (HubSpot is CRM projection; IFCDC remains system of record)
- Marketing email send from the Node API (prefer HubSpot Marketing Hub / workflows)
- Syncing every historical booking on day one (backfill is a controlled job)

---

## 3. Architecture

```
IFCDC API (canonical Render only)
  ├─ hubspotService.js          # shared client, retries, canonical gate
  ├─ hubspotContactSync (P1)    # email upsert
  ├─ hubspotCompanySync (P2)    # businesses → companies
  ├─ hubspotDealSync (P2)       # bookings → deals
  ├─ hubspotWorkflowHooks (P2)  # property updates that workflows listen to
  └─ hq/hubspotAnalytics (P2)   # read-only KPIs for IFCDC HQ
```

**Mapping tables (already stubbed in `hubspotMigrations.js`):**

- `hubspot_sync_companies` — `business_id` → `hubspot_company_id`
- `hubspot_sync_deals` — `booking_id` → `hubspot_deal_id`
- `hubspot_sync_entities` / `hubspot_sync_events` — extensible audit

**Association model:**

- Contact ↔ Company (customer ↔ shop; barber user ↔ shop where applicable)
- Deal ↔ Contact (appointment customer)
- Deal ↔ Company (shop fulfilling the appointment)

---

## 4. Workstreams

### 4.1 Companies (Barbershops)

**Triggers (non-blocking):**

- Shop create / approve / profile update (`businesses`, shop settings)
- Barber linked to a business (association refresh)

**Properties (proposed):**

- `name`, `address`, `city`, `state`, `phone`, `domain`/`website` (if present)
- Custom: `ifcdc_business_id`, `ifcdc_shop_status`, `ifcdc_barber_count`

**Idempotency:** upsert by `ifcdc_business_id` custom property (preferred) or name+address fallback; store HubSpot id in `hubspot_sync_companies`.

**Acceptance:** create/update shop in IFCDC → company appears/updates in HubSpot; duplicate shop updates do not create a second company.

### 4.2 Deals (Appointments)

**Triggers:**

- Booking created / confirmed / paid / completed / cancelled / no-show
- PayPal capture success and refund paths (property updates only)

**Pipeline (create in HubSpot once, document IDs in env or config):**

| Stage | Maps from |
|-------|-----------|
| Appointment scheduled | booking created / hold confirmed |
| Deposit / paid | PayPal captured / paid in full |
| Completed | appointment completion |
| Cancelled / no-show | cancel / no-show events |

**Properties (proposed):**

- `dealname` (e.g. `{service} — {customer} — {date}`)
- `amount` (booking total)
- `closedate` (appointment start)
- Custom: `ifcdc_booking_id`, `ifcdc_barber_id`, `ifcdc_service`, `ifcdc_payment_status`, `ifcdc_loyalty_points_earned`

**Acceptance:** book → pay → complete without HubSpot errors affecting PayPal; deal stage moves correctly; email-keyed contact remains single.

### 4.3 Automated HubSpot workflows

Configure in HubSpot UI (not hard-coded email in Node). API/backend only sets the properties/events workflows need.

| Workflow | Trigger property / event | Action (HubSpot) |
|----------|--------------------------|------------------|
| Review request | Deal → Completed + delay | Email/SMS task asking for review; link to IFCDC review URL |
| Loyalty reward | Contact property `ifcdc_loyalty_tier` / points threshold | Congrats email + reward CTA |
| Rebooking reminder | Deal completed + N days | Reminder to rebook same barber/shop |
| Birthday | Contact `date_of_birth` (if collected) or HubSpot birthday | Birthday offer |
| Marketing campaigns | Lists/segments from engagement + loyalty | HubSpot campaigns (ops-owned) |

**Backend responsibilities:**

- Keep contact/company/deal properties fresh
- Optional: secure webhook endpoint for HubSpot → IFCDC (e.g. “reward claimed”) — Phase 2b if needed
- Do **not** duplicate campaign sending in Node if HubSpot already owns it

### 4.4 IFCDC HQ analytics & KPIs (shipped — Phase 2D)

**Flag:** `HUBSPOT_HQ_ANALYTICS=1` (requires `HUBSPOT_SYNC_ENABLED` + canonical runtime)

**Endpoint:** `GET /api/admin/hubspot/kpis?days=30` (admin JWT or `x-admin-key`)

**Surfaces (HQ admin):**

- Customer growth, returning rate, appointment volume, revenue trends
- Top barbers / shops, CLV (emails redacted)
- Marketing signals from local loyalty campaigns + `hubspot_sync_events` (not HubSpot Marketing open/click rates)
- HubSpot sync health from `hubspot_sync_contacts|companies|deals`

**UI:** web Admin “HubSpot & CRM analytics”; mobile Platform analytics

### 4.5 Compatibility & safety

- Canonical-only runtime (already in Phase 1 cleanup)
- Feature flags: `HUBSPOT_SYNC_ENABLED`, plus optional `HUBSPOT_SYNC_COMPANIES`, `HUBSPOT_SYNC_DEALS`, `HUBSPOT_SYNC_WORKFLOWS`, `HUBSPOT_HQ_ANALYTICS`
- All sync via `enqueue*` fire-and-forget
- Retries / 429 backoff (existing client)
- No secret logging
- Regression suite: register, booking health, PayPal live health, loyalty endpoints, appointment finalize validation

---

## 5. Delivery phases (within Phase 2)

| Step | Deliverable | Gate |
|------|-------------|------|
| **2.0** | Custom properties + pipelines documented; permissions verified | HubSpot portal ready |
| **2.1** | Company sync + associations to contacts | Staging/prod smoke |
| **2.2** | Deal sync + stage transitions on pay/complete/cancel | PayPal + booking regression green |
| **2.3** | Property contract for workflows; enable workflows in HubSpot | Ops sign-off on emails |
| **2.4** | HQ KPI endpoint + UI cards | Admin review |
| **2.5** | Optional historical backfill job (batched) | Explicit approval |

---

## 6. Test plan

1. **Auth/health** — `/api/hubspot/health` still OK on canonical only; d8ui syncEnabled false  
2. **Company** — create/update shop → one HubSpot company; mapping row present  
3. **Deal** — full booking → pay (sandbox or dry validation) → complete → stage path correct  
4. **Associations** — deal linked to contact + company  
5. **Isolation** — kill HubSpot token temporarily → booking/PayPal still succeed  
6. **Workflows** — test enrollment in HubSpot with a labeled test contact  
7. **HQ** — KPI endpoint returns counts without secrets  

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Wrong Render service gets HubSpot env again | Canonical runtime guard + strip d8ui script |
| Deal spam from holds/cancellations | Sync on confirmed/paid thresholds; debounce updates |
| Property/pipeline drift | Versioned property map in code + docs; fail soft |
| HubSpot rate limits | Existing client spacing + queue/backoff |
| PII in logs | Continue redaction; never log `HUBSPOT_SERVICE_KEY` |

---

## 8. Approval checklist (before coding)

- [ ] Confirm HubSpot Marketing/ops owns workflow email copy  
- [ ] Confirm deal pipeline stage names  
- [ ] Confirm custom property namespace (`ifcdc_*`)  
- [ ] Confirm whether birthday is collected in-app today (or defer birthday workflow)  
- [ ] Confirm HQ surfaces: web admin only vs mobile admin too  
- [ ] Explicit go-ahead to implement **2.1** (companies) first  

---

*No Phase 2 implementation work begins until you approve this plan (or a revised version).*
