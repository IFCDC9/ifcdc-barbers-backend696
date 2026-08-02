# AURA Phase 3 — Business Intelligence & Customer Experience

**All Phase 3 flags default OFF.** Do not enable in production until controlled testing and explicit approval.

Phase 2 booking, payment, email, reminder, reporting, website, and mobile workflows remain unchanged when Phase 3 flags are off.

## First controlled deliverable (3A only)

- Knowledge-management data model + versioning
- Super Admin knowledge CRUD API (+ web editor)
- Read-only knowledge retrieval for AURA
- Natural-language FAQ / info answers from approved + live sources
- Source / confidence / timestamp logging to `aura_action_logs`
- Escalation when missing, conflicting, unapproved, or unsafe
- Deferred: preferences, waitlist, slot recovery, operational outreach

---

## 1. Architecture plan

```
Customer question
    → security filters (injection / unauthorized)
    → category inference
    → approved aura_knowledge_articles (effective dates)
    → optional live_db adapter (barber_services, barbers, businesses, schedules)
    → answer OR escalate
    → aura_action_logs (source, version, confidence, result)
```

Live sources are preferred for prices, durations, hours, location, and barber roster. Curated articles cover policies/FAQ that are not in transactional tables. AURA never invents values.

No new external DB, vector vendor, or paid AI knowledge service in 3A. Retrieval is keyword/category scoring over Postgres.

## 2. Database changes (additive)

| Table | Purpose |
|-------|---------|
| `aura_knowledge_articles` | Versioned public knowledge rows (`draft` / `approved` / `disabled`) |
| `aura_knowledge_versions` | Immutable history snapshots on each change |

Columns include: `slug`, `category`, `title`, `body`, `source_type` (`curated` \| `live_db` \| `hybrid`), `live_query_key`, `status`, `version`, `confidence`, `is_public`, `effective_from`, `effective_to`, approval audit fields.

Applied on boot only when `AURA_PHASE3_ENABLED=1`.

## 3. Files changed / added

| File | Role |
|------|------|
| `auraPhase3Flags.cjs` | Feature flags |
| `auraKnowledgeMigrations.cjs` | Schema |
| `auraKnowledgeSecurity.cjs` | Injection / unauthorized guards |
| `auraKnowledgeLiveSources.cjs` | Live Postgres adapters |
| `auraKnowledgeService.cjs` | CRUD + answer/escalate |
| `auraKnowledgeRoutes.cjs` | `/api/aura/phase3/*` |
| `server.js` | Mount routes; optional chat knowledge hook |
| `docs/AURA_PHASE3.md` | This plan |
| `tests/auraPhase3*.test.mjs` | Unit / behavior tests |
| `client/src/pages/AdminAuraKnowledge.jsx` | Super Admin editor |
| `client/src/App.jsx` | `/admin/aura-knowledge` route |
| `.env.example` | Document flags |

## 4. New environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AURA_PHASE3_ENABLED` | off | Master Phase 3 switch |
| `AURA_PHASE3_KNOWLEDGE` | off | Knowledge retrieval + admin editor |
| `AURA_PHASE3_CONVERSATION` | off | Reserved (follow-ups / confirmations) — not required for 3A FAQ |
| `AURA_PHASE3_CUSTOMER_PREFERENCES` | off | Deferred 3B |
| `AURA_PHASE3_WAITLIST` | off | Deferred 3B |
| `AURA_PHASE3_SLOT_RECOVERY` | off | Deferred 3B |
| `AURA_PHASE3_OPERATIONAL_INSIGHTS` | off | Deferred 3C |

## 5. Feature flags

All default **false**. Production activation requires explicit approval after controlled tests.

## 6. Security controls

- Customer text sanitized + length-capped
- Prompt-injection patterns blocked + logged
- Unauthorized topics (refund tooling, other customers, credentials, destructive SQL) blocked + escalated
- Only `approved` + effective + `is_public` articles answer customers
- Draft/disabled never spoken
- Conflicting equal-score articles → escalate (no guess)
- Live adapter failure → escalate (no invented prices/hours)
- Admin CRUD requires existing bookings admin/super guard
- No internal notes / env secrets / customer PII in answers
- Rate limiting remains on existing AURA chat stack; knowledge ask is read-only

## 7. Test plan

1. Correct live services/pricing answer when catalog exists  
2. Missing knowledge → escalate  
3. Conflicting approved articles → escalate  
4. Prompt injection → blocked  
5. Unauthorized topic → blocked  
6. Flags off → 404 / no-op (Phase 2 chat unchanged)  
7. Draft article never returned to customers  
8. Admin create / approve / disable / version increment  

## 8. Rollback plan

1. Set all `AURA_PHASE3_*` to `false` on Render (immediate)  
2. Optional: redeploy pre-Phase-3 commit / tag  
3. Tables are additive — safe to leave unused; no Phase 2 columns altered  
4. Create git tag before any production Phase 3 enablement: `rollback/pre-aura-phase3-YYYY-MM-DD`

## 9. Phase 2 unchanged confirmation

When Phase 3 flags are off:

- Phase 2 routes, tools, reminders, daily report, review follow-up, emails: unchanged  
- Chat uses existing keyword / OpenAI path (knowledge hook is no-op)  
- No booking/payment/PayPal/MAIL_FROM changes in this deliverable  

## API (local / when flags on)

- `GET /api/aura/phase3/status`
- `POST /api/aura/phase3/knowledge/ask` `{ "question": "..." }`
- `GET|POST|PATCH /api/aura/phase3/admin/knowledge...` (admin)
- `POST /api/aura/phase3/admin/knowledge/seed-drafts`
- `POST /api/aura/phase3/admin/migrate`

## Stop line

Phase 3A is implemented **locally behind disabled flags**. Do **not** set `AURA_PHASE3_ENABLED=true` in production until controlled testing is approved.
