# AURA Phase 2

Feature-flagged expansion of AURA as the IFCDC Barbers digital receptionist.
**All flags default OFF.** Do not enable in production until E2E verification and explicit approval.

## Hard constraints

- Do **not** change live `MAIL_FROM` / Resend sender until Resend verifies the AURA subdomain and a test delivery succeeds.
- Preferred **future** sender (not active yet): `AURA <aura@aura.ifcdcbarbersapp.com>`
- Keep using the current working `MAIL_FROM` on `ifcdcbarbersapp.com`.
- Daily Super Admin report is **foundation-only** until `AURA_DAILY_REPORT_ENABLED=1` is approved as a second step.
- Do not change PayPal, booking writers, or Render env without approval.

## Feature flags

| Variable | Purpose | Default |
|----------|---------|---------|
| `AURA_PHASE2_ENABLED` | Master switch | off |
| `AURA_PHASE2_REMINDERS_24H` | 24h reminder emails | off |
| `AURA_PHASE2_REMINDERS_2H` | 2h reminder emails | off |
| `AURA_PHASE2_REMINDERS_30M` | Legacy ~30m scanner under Phase 2 | off |
| `AURA_PHASE2_BARBER_NOTIFY` | Barber email on create/cancel/reschedule | off |
| `AURA_PHASE2_ADMIN_ALERTS` | Super Admin failure alerts | off |
| `AURA_PHASE2_TOOLS_ENABLED` | find/cancel/reschedule/book tools | off |
| `AURA_PHASE2_REVIEW_FOLLOWUP` | Completion Rate Me + rewards email | off |
| `AURA_PHASE2_RESCHEDULE_EMAIL` | Extra AURA-branded reschedule email | off |
| `AURA_DAILY_REPORT_PREVIEW` | Allow report preview/dry-run | off |
| `AURA_DAILY_REPORT_ENABLED` | **Send** daily digest (step 2) | off |
| `AURA_DAILY_REPORT_TO` | Digest recipient | falls back to `BOOKING_ADMIN_EMAIL` |

## Additive DB (auto-applied when master flag is on at boot)

- `bookings.reminder_24h_sent_at`
- `bookings.reminder_2h_sent_at`
- `bookings.reminder_sent_at` (ensure)
- `aura_action_logs` (actor, user_id, action, booking_id, result, metadata, created_at)

## Ops routes (404 unless master on; admin-guarded)

- `GET /api/aura/phase2/status`
- `GET /api/aura/phase2/daily-report?day=YYYY-MM-DD` (dry-run by default; `?send=1` only if send flag on)
- `POST /api/aura/phase2/tools/:toolName`
- `POST /api/aura/phase2/reminders/scan`
- `POST /api/aura/phase2/migrate`

## Daily report dry-run script

```bash
node --import ./loadBackendEnv.mjs scripts/run-aura-daily-report.mjs
node --import ./loadBackendEnv.mjs scripts/run-aura-daily-report.mjs --day=2026-08-01
```

## Booking via AURA tools

`confirm_book` validates the slot then returns `NAVIGATE_BOOK` + prefill. Paid rows are still created only through existing PayPal/checkout — AURA never invents payment captures.

## Safety deny-list

Refunds, price changes, hard deletes, admin permission changes, and payment-credential changes are denied and escalated to Super Admin.
