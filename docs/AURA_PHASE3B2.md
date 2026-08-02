# AURA Phase 3B2 — Waitlist and Open-Slot Recovery

**All Phase 3B2 flags default OFF.** Do not enable on Render, migrate production, or commit/deploy without explicit approval.

Phase 2, Phase 3A knowledge, and Phase 3B1 preferences remain unchanged when waitlist flags are off.

Operational insights and proactive marketing outreach remain disabled.

---

## 1. Architecture plan

```
Customer consent offer → confirm criteria
  → grant: create/merge active waitlist request (no booking, no charge)
  → decline: nothing saved

Cancelled / freed slot (slot recovery flag)
  → revalidate slot
  → match eligible active requests (transparent score + FIFO)
  → create at most one open offer for that physical slot
  → customer Accept → atomic claim lock → booking-summary confirmation required
  → customer Decline / expire → no booking
  → notifications only if WAITLIST_NOTIFICATIONS separately enabled (otherwise log-only)
```

Joining a waitlist never creates a booking or payment authorization. Preferences / waitlist never override schedules, blocked times, qualifications, pricing, or auth rules.

## 2. Database migration (additive)

| Table | Purpose |
|-------|---------|
| `aura_waitlist_requests` | Soft-deleted waitlist criteria + consent + status |
| `aura_waitlist_events` | Immutable request audit events |
| `aura_slot_offers` | Controlled slot offers with expiration + claim token |
| `aura_slot_offer_events` | Immutable offer audit events |

Key fields: `customer_id`, barber/service fields, date/time range, `any_qualified_barber`, `earliest_available`, `status`, `priority_basis` (`created_at_fifo`), consent timestamps, `expires_at`, offer expiration, `claimed_booking_id`, soft delete, audit metadata.

Applied on boot only when `AURA_PHASE3_ENABLED` + `AURA_PHASE3_WAITLIST` are on (local). **Not run in production in this deliverable.**

## 3. Files changed / added

| File | Role |
|------|------|
| `auraPhase3Flags.cjs` | `waitlist`, `slotRecovery`, `waitlistNotifications` |
| `auraWaitlistMigrations.cjs` | Schema |
| `auraWaitlistSecurity.cjs` | Criteria normalize + transparent match scoring |
| `auraWaitlistService.cjs` | Consent, CRUD, match, offer, atomic claim |
| `auraWaitlistRoutes.cjs` | `/api/aura/phase3/waitlist*` |
| `auraKnowledgeRoutes.cjs` | Attach waitlist routes |
| `server.js` | Boot migrate when waitlist flag on |
| `.env.example` / `package.json` / flag tests | Docs + test runner |
| `docs/AURA_PHASE3B2.md` | This plan |
| `tests/auraPhase3Waitlist.test.mjs` | Controlled unit tests |

## 4. Feature flags

| Variable | Default | Purpose |
|----------|---------|---------|
| `AURA_PHASE3_WAITLIST` | false | Waitlist join/view/update/pause/remove |
| `AURA_PHASE3_SLOT_RECOVERY` | false | Match + offer + accept/decline (requires waitlist) |
| `AURA_PHASE3_WAITLIST_NOTIFICATIONS` | false | Outbound notifications (separate approval; local path logs only) |

## 5. Matching and fairness rules

Transparent score only:

1. Matching barber (or any-qualified-barber flexibility)
2. Matching service
3. Matching date / date range / earliest acceptable
4. Matching time range
5. Tie-break: waitlist `created_at` FIFO (`priority_basis=created_at_fifo`)

**Not used:** payment history, customer-value scores, protected characteristics, subjective favoritism.

Expired, paused, deleted, declined-consent, or fulfilled requests are ineligible.

Only one open offer may exist for a given barber+date+time+service slot (no multi-customer “guaranteed” messaging).

## 6. Concurrency controls

- Accept uses conditional `UPDATE ... WHERE status='offered' AND offer_expires_at > NOW()` with `claim_token`
- Late/duplicate accepts fail safely (`claim_conflict` / `already_claimed` / `offer_expired`)
- Competing open offers for the same physical slot are `superseded`
- Booking is **not** auto-created; claim requires explicit booking-summary confirmation and existing payment rules
- Offer creation is idempotent via `idempotency_key`

## 7. Notification controls

- No outbound send while `AURA_PHASE3_WAITLIST_NOTIFICATIONS=false`
- Cap: max 3 offer-related notification logs per customer per day
- Respect future communication preferences; opt-out via removing/pausing waitlist
- Local/testing path logs intent only (`waitlist_notification_skipped` / `logged_only`)

## 8. Test results (local)

Controlled waitlist suite (`tests/auraPhase3Waitlist.test.mjs`): **6/6 PASS**

- Join with consent / decline consent (no booking, no charge)
- View/update/pause/remove + duplicate merge + cross-customer rejection
- Unauthorized / expired exclusion from matches
- Slot offer, decline, accept pending → claim, duplicate accept blocked, no auto book/pay
- Notifications stay off; unavailable slot rejects offer

Full Phase 3 suite: `npm run test:aura-phase3` → **29/29 PASS**  
(Phase 3A knowledge + 3B1 preferences + 3B2 waitlist + flags + security)

## 9. Rollback plan

**Pre-deploy rollback tag (created before this review commit):**  
`rollback/pre-aura-phase3b2-2026-08-02` → commit `d8f23c45` (last approved Phase 3B1 suggestions harden).

1. Keep all three 3B2 flags false (default) — **required on Render after this deploy**
2. To roll back code: `git checkout rollback/pre-aura-phase3b2-2026-08-02` (or redeploy that commit)
3. Leave additive waitlist tables unused if they were ever created; with flags off they are not applied on boot
4. Do not enable waitlist / slot recovery / notifications on Render until explicit approval

## 10. Regression

`npm run test:aura-phase2` → **11/11 PASS** (tools, reminders, daily report, identity gate)

When waitlist flags are off: Phase 2 tools/reminders/reports, Phase 3A knowledge, and Phase 3B1 preferences remain unchanged; waitlist schema is not applied on boot.

## Stop line

Phase 3B2 is implemented **locally behind disabled flags**. Do **not** commit, deploy, migrate production, or enable Render flags without explicit approval.
