# Supabase RLS security — vtkxuagevtiwtoheomjt

## Alert

Supabase flagged **rls_disabled_in_public**: a table in `public` was readable/editable via the anon API key without Row Level Security.

## How IFCDC uses Supabase

| Path | Key | RLS applies? |
|------|-----|----------------|
| Website / app API | `DATABASE_URL` (Postgres pool) | **No** — backend bypasses RLS |
| Photo uploads | `SUPABASE_SERVICE_ROLE_KEY` | **No** — service role bypasses RLS |
| Browser / mobile direct | `anon` / publishable key | **Yes** — must be locked down |

Booking, PayPal, email, and admin flows use the **Node API only** — enabling RLS does not break them.

## Fix (urgent)

### Option A — SQL Editor (recommended)

1. Open [Supabase Dashboard](https://supabase.com/dashboard/project/vtkxuagevtiwtoheomjt/sql/new)
2. Paste contents of `src/db/supabase_rls_lockdown.sql`
3. Run
4. Confirm Security Advisor clears the alert (may take a few minutes)

### Option B — CLI script

```bash
node --import ./loadBackendEnv.mjs scripts/audit-supabase-rls.mjs
node --import ./loadBackendEnv.mjs scripts/apply-supabase-rls.mjs
node --import ./loadBackendEnv.mjs scripts/audit-supabase-rls.mjs
```

## What the lockdown does

1. Enables RLS on **every** `public` table
2. Revokes broad `anon`/`authenticated` table grants
3. **Backend-only tables** — RLS on, no client policies (bookings, app_users, payments, barbers, barber_services, etc.)
4. **barber_style_photos** — public SELECT; writes require authenticated session
5. **appointments / customers** — authenticated only (Supabase bridge / legacy)
6. **storage.objects** — public read on `barber-styles`; uploads via service_role API unchanged

## Post-apply smoke tests

```bash
npm run verify:storage
node scripts/test-production-readiness.mjs
node --import ./loadBackendEnv.mjs scripts/test-photo-pipeline.mjs
```

Manual:

- [ ] Website booking + PayPal
- [ ] Admin photo upload / delete
- [ ] TestFlight booking (Build 32)
- [ ] Registration / login

## Function hardening (search_path)

Security Advisor may flag **function_search_path_mutable** on loyalty/geo RPCs.

```bash
npm run backup:db
npm run apply:function-hardening
npm run audit:security
```

`src/db/supabase_function_hardening.sql`:

- Pins `search_path = public, pg_temp` on all custom plpgsql functions
- Revokes `anon`/`authenticated` EXECUTE on **SECURITY DEFINER** loyalty RPCs (they bypass RLS)
- Leaves read-only helpers (`get_nearby_barbers`, etc.) callable by anon (RLS still applies)

## Do not

- Disable RLS after enabling without policies
- Expose `service_role` key in the client
- Add `USING (true)` policies on bookings/payments for `anon`
