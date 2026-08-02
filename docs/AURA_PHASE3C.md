# AURA Phase 3C — Operational Intelligence

**All Phase 3C flags default OFF.** Do not commit, deploy, migrate production, or activate without explicit approval.

Phase 2 and Phase 3A/3B1/3B2 remain unchanged when operational-insights flags are off.

AURA may analyze and report. AURA must **not** automatically change prices, discounts, schedules, services, appointments, payments, permissions, outreach, or employee standing.

---

## 1. Architecture plan

```
Super Admin selects period (+ optional comparison)
  → flag gate (OPERATIONAL_INSIGHTS + INSIGHTS_DASHBOARD)
  → duplicate fingerprint check (aura_action_logs)
  → read-only gathers (bookings, waitlist, logs, loyalty, languages, availability)
  → exclude controlled test records
  → compute section metrics
  → optional recommendations (RECOMMENDATIONS flag) with confidence / INSUFFICIENT DATA
  → scrub PII
  → audit log operational_insight_report_generated
  → JSON response (read-only; no mutations)
```

Daily digest (`INSIGHTS_DAILY_DIGEST`) is preview/log-only in this foundation — **no outbound send**.

---

## 2. Data-source map

| Domain | Sources | Notes |
|--------|---------|-------|
| Booking performance | `bookings` | Status, reschedule columns, created_at vs appointment |
| Waitlist conversion | `aura_slot_offers` | Offered / claimed / declined / expired |
| Capacity | `bookings`, optional `barber_availability` | Utilization % requires availability minutes |
| Revenue | `bookings.amount_paid` / `total_paid`, `payment_status`, `refunded_at` | Not a raw `payments` dump |
| Service demand | `bookings.service`, `aura_waitlist_requests` | Aggregate only |
| Languages | `app_users.preferred_language` | Aggregate counts |
| Rewards | `loyalty_rewards` | Aggregate eligible count |
| System health | `aura_action_logs` | Failures, duplicates, escalations |
| Audit | `aura_action_logs` | Every report generation |

No new production tables are required for this local foundation (no production migration).

---

## 3. Metric definitions and formulas

| Metric | Formula |
|--------|---------|
| Total bookings | Count non-test bookings with `date` in period |
| Completed | `booking_status = completed` |
| Cancellations | `cancelled` / `canceled` |
| No-shows | `no_show` / `noshow` |
| Reschedules | Rows with `rescheduled_at` or `rescheduled_from_date` |
| Avg advance-booking hours | Mean of (appointment datetime − created_at) when positive |
| Waitlist conversion | `claimed / offers × 100` from `aura_slot_offers` |
| Payments received | Sum `amount_paid`/`total_paid` where paid-like status, amount > 0, not refunded, not test/unpaid/failed/bypass/cancelled |
| Avg booking value | Payments received ÷ revenue booking count |
| Potential waitlist recovered revenue | `claimed × avg booking value` (labeled estimate only) |
| Barber utilization % | Booked service minutes ÷ estimated available minutes (else **INSUFFICIENT DATA**) |
| Underbooked / high-demand | Day-of-week + hour buckets vs period mean (< 50% / ≥ 150%) |
| Repeat customers | Aggregate count of identifiers with ≥ 2 bookings (no PII returned) |

---

## 4. Files changed / added

| File | Role |
|------|------|
| `auraPhase3Flags.cjs` | 3C subflags |
| `auraOperationalInsightsSecurity.cjs` | Test exclusion, PII scrub, fairness gates, periods |
| `auraOperationalInsightsMetrics.cjs` | Formulas + SQL gathers |
| `auraOperationalInsightsRecommendations.cjs` | Explainable / insufficient / conflicting |
| `auraOperationalInsightsService.cjs` | Orchestration + audit + digest preview |
| `auraOperationalInsightsRoutes.cjs` | Super Admin `/api/aura/phase3/...` |
| `auraKnowledgeRoutes.cjs` | Attach insights routes; status note |
| `.env.example` / `package.json` | Docs + test runner |
| `docs/AURA_PHASE3C.md` | This plan |
| `tests/auraPhase3Insights.test.mjs` | Controlled unit tests |
| `tests/auraPhase3Flags.test.mjs` | Extended flag coverage |

---

## 5. Feature flags (all default false)

| Variable | Default | Purpose |
|----------|---------|---------|
| `AURA_PHASE3_OPERATIONAL_INSIGHTS` | false | Master 3C read-only analysis |
| `AURA_PHASE3_INSIGHTS_DASHBOARD` | false | Super Admin report API |
| `AURA_PHASE3_INSIGHTS_DAILY_DIGEST` | false | Digest preview path (no send in foundation) |
| `AURA_PHASE3_RECOMMENDATIONS` | false | Explainable recommendations |

Subflags require master `AURA_PHASE3_ENABLED` **and** `AURA_PHASE3_OPERATIONAL_INSIGHTS`.

---

## 6. Privacy and fairness safeguards

- Controlled test records excluded by name/email/notes/source markers
- API responses scrub emails, phones, secrets, payment credentials, private notes
- Aggregate customer metrics only — no hidden scores or value/risk labels
- Capacity/revenue metrics framed as demand/availability, not employee performance
- Recommendations cannot request discipline, termination, hour cuts, or pay changes
- Reports are read-only; authority block lists all automatic operational powers as false

---

## 7. Local test results

Controlled insights suite (`tests/auraPhase3Insights.test.mjs`): **10/10 PASS**

- Flags default off; report blocked when insights disabled
- Booking totals + status classification; test rows excluded
- Revenue excludes unpaid / failed / test
- Utilization framing; underbooked / high-demand detection; insufficient utilization without availability
- Waitlist demand + system health (failed email/payment, waitlist notify failures, escalations)
- INSUFFICIENT DATA + CONFLICTING DATA recommendation gates
- Disciplinary recommendation language blocked; PII scrubbed
- Full report read-only + audited + no automatic authority; digest preview never sends

Full Phase 3 suite: `npm run test:aura-phase3` → **39/39 PASS**  
Phase 2 suite: `npm run test:aura-phase2` → **11/11 PASS**

---

## 8. Rollback plan

**Pre-deploy rollback tag (created before Phase 3C flags-off deploy):**  
`rollback/pre-aura-phase3c-2026-08-02` → commit `0ee03e69` (last approved Phase 3B2 waitlist notifications).

1. Keep all 3C flags false (default) — **required on Render after this deploy**
2. To roll back code: `git checkout rollback/pre-aura-phase3c-2026-08-02` (or redeploy that commit)
3. No production schema migration in this deliverable
4. Do not enable any Phase 3C feature on Render until explicit approval

---

## 9. Regression

Run Phase 2 + Phase 3 suites after local implementation.

---

## 10. Confirmation — no automatic operational authority

`authorityGuard()` on every report sets:

- `automaticActions: false`
- no price/discount/schedule/service/outreach/booking/payment/permission/discipline powers

Recommendations always include `autoApplied: false` and `actionRequiresApproval`.
