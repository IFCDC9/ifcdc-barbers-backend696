# AURA Phase 3B1 — Customer Preferences

**All Phase 3B1 flags default OFF.** Do not enable on Render until controlled testing and explicit approval.

Phase 3A knowledge and Phase 2 booking/payment/reminder/reporting workflows remain unchanged when preference flags are off.

Waitlist, slot recovery, proactive outreach, and operational insights remain deferred and disabled.

---

## 1. Architecture plan

```
Consent offer (prompt only)
    → customer declines  → log, no save
    → customer grants    → normalize + security filters
                         → upsert owned preference (soft-delete aware)
                         → preference events + aura_action_logs

Suggestions (optional flag)
    → read owned preferences
    → return suggestion text only
    → never book / charge / contact automatically
    → availability/pricing/policies still authoritative
```

Preferences are operational hints only. They never override availability, pricing, policies, barber schedules, blocked times, or authorization.

## 2. Database migration (additive)

| Table | Purpose |
|-------|---------|
| `aura_customer_preferences` | Soft-deleted preference rows with consent fields |
| `aura_customer_preference_events` | Immutable consent/create/update/delete audit events |

Proposed columns on `aura_customer_preferences`:

- `id` (preference_id)
- `customer_id`
- `preference_type`
- `preference_value` (JSONB)
- `consent_status` (`pending` \| `granted` \| `declined` \| `withdrawn`)
- `consent_timestamp`
- `created_at` / `updated_at` / `deleted_at`
- `created_by` (`customer` \| `aura` \| `admin`)
- `source`
- `audit_metadata`

Unique active row per `(customer_id, preference_type)` where `deleted_at IS NULL` and `consent_status = 'granted'`.

Applied on boot only when `AURA_PHASE3_ENABLED` and `AURA_PHASE3_CUSTOMER_PREFERENCES` are on (local). Production migrate is not run in this deliverable.

## 3. Files changed / added

| File | Role |
|------|------|
| `auraPhase3Flags.cjs` | `customerPreferences` + `preferenceSuggestions` |
| `auraPreferenceMigrations.cjs` | Schema |
| `auraPreferenceSecurity.cjs` | Allowed types + prohibited content |
| `auraPreferenceService.cjs` | Consent, CRUD, suggestions, no-override guard |
| `auraPreferenceRoutes.cjs` | `/api/aura/phase3/preferences*` |
| `auraKnowledgeRoutes.cjs` | Attach preference routes; status note |
| `server.js` | Pass `requireAuth`; optional boot migrate when flag on |
| `.env.example` | Document 3B1 flags |
| `docs/AURA_PHASE3B1.md` | This plan |
| `tests/auraPhase3Preferences.test.mjs` | Controlled unit tests |
| `tests/auraPhase3Flags.test.mjs` | Flag defaults |
| `package.json` | Include preference tests in `test:aura-phase3` |

## 4. Feature flags

| Variable | Default | Purpose |
|----------|---------|---------|
| `AURA_PHASE3_CUSTOMER_PREFERENCES` | false | Consent + preference storage APIs |
| `AURA_PHASE3_PREFERENCE_SUGGESTIONS` | false | Suggestion prompts only (requires preferences flag + master) |

Also requires `AURA_PHASE3_ENABLED` (master). Keep waitlist / slot recovery / operational insights off.

## 5. Consent workflow

1. AURA calls `POST /preferences/consent/offer` with a proposed type/value.
2. Customer receives a clear prompt, e.g. “Would you like me to remember that you prefer Saturday morning appointments with this barber?”
3. Decline → `POST /preferences/consent/decline` (nothing saved).
4. Accept → `POST /preferences` with `consentGranted: true` (save/update).
5. Withdraw → `POST /preferences/consent/withdraw` (soft-deletes all + audit).

Ordinary conversation without `consentGranted: true` never saves.

## 6. Security controls

- Auth required on customer preference routes; ownership enforced on every read/write
- Cross-customer get/delete returns `not_found_or_forbidden`
- Allowed types only; unauthorized types rejected
- Prompt-injection and prohibited content (credentials, health, other customers, etc.) rejected
- Admin may review/remove only — cannot create hidden preference profiles via admin create API
- `assertPreferenceDoesNotOverride` blocks using preferences to force unavailable slots
- Suggestions never set `autoBook: true`
- Data stored in existing Postgres security model (no new vendor)

## 7. Test results (local)

Run: `npm run test:aura-phase3` and `npm run test:aura-phase2`

Covered:

- Consent accepted / declined
- Create / update / delete one / delete all / withdraw
- Cross-customer rejection
- Unauthorized type + prompt-injection rejection
- No override of unavailable times; no automatic booking
- Duplicate active preference prevention (one per type)
- Phase 3 flags default off; 3B/3C remain off unless explicitly enabled

## 8. Rollback plan

1. Keep / set `AURA_PHASE3_CUSTOMER_PREFERENCES=false` and `AURA_PHASE3_PREFERENCE_SUGGESTIONS=false` (immediate)
2. Optional: leave additive tables unused
3. Do not enable on Render until explicit approval
4. Phase 3A rollback tag remains: `rollback/pre-aura-phase3-2026-08-02`

## 9. Phase 2 and Phase 3A regression

When preference flags are off:

- Phase 3A knowledge ask/admin paths unchanged
- Phase 2 tools, reminders, daily report, PayPal/booking paths unchanged
- Preference schema is not applied on boot unless preferences flag is on

---

## API (local, when flags on)

- `GET /api/aura/phase3/preferences/status`
- `POST /api/aura/phase3/preferences/consent/offer|decline|withdraw`
- `GET|POST|PATCH|DELETE /api/aura/phase3/preferences/me...`
- `GET /api/aura/phase3/preferences/suggestions`
- `POST /api/aura/phase3/preferences/assert-no-override`
- `GET|DELETE /api/aura/phase3/admin/preferences...` (review/remove only)

## Stop line

Phase 3B1 is implemented **locally behind disabled flags**. Do **not** commit, deploy, migrate production, or enable Render flags without explicit approval.
