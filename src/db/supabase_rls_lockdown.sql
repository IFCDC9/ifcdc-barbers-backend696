-- =============================================================================
-- IFCDC Barbers — Supabase RLS lockdown (public schema)
-- Project: vtkxuagevtiwtoheomjt (supabase-emerald-kite)
--
-- RUN IN: Supabase Dashboard → SQL Editor (production)
-- Or:     node --import ./loadBackendEnv.mjs scripts/apply-supabase-rls.mjs
--
-- Architecture:
--   • Website + TestFlight → Node API (DATABASE_URL / service_role) — NOT blocked
--   • Anon/publishable key → PostgREST only — MUST be blocked on sensitive tables
--
-- Safe to re-run (idempotent drops + creates).
-- =============================================================================

-- ---- 1) Enable RLS on every public table ------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    RAISE NOTICE 'RLS enabled on public.%', r.tablename;
  END LOOP;
END $$;

-- ---- 2) Revoke dangerous default grants (defense in depth) ------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- ---- 3) Drop legacy permissive policies (all public tables) -----------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ---- 4) BACKEND-ONLY tables (no PostgREST access for anon/authenticated) ----
-- RLS on + no policies = blocked for anon/authenticated via Supabase API.
-- Node backend (postgres / service_role) continues to work.

-- Bookings & payments
-- (bookings, payment_attempts, payments, barber_fee_ledger, booking_audit_log,
--  booking_status_history — RLS enabled above, no client policies)

-- Users & auth
-- (app_users, pending_user_invites, auth_bridge, users, legal_acceptances,
--  push_tokens, notification_preferences, security_audit_log, service_audit_log)

-- Barber business data
-- (barbers, barber_services, barber_clients, barber_portfolio_images,
--  barber_profiles, barber_styles, style_images, styles, businesses,
--  barber_settings, barber_availability, barber_availability_breaks,
--  barber_blocked_dates, barber_subscriptions, site_content)

-- AURA / memory
-- (aura_user_preferences, aura_chat_messages, customer_memory, user_memory)

-- Legacy shop tables (backend/voice only; anon client is disabled in code)
-- (tips, queue, barber_status, barber_media, shops)

-- ---- 5) appointments & customers — authenticated only (if tables exist) ----
DO $policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'appointments') THEN
    EXECUTE $sql$
      CREATE POLICY "appointments_authenticated_all"
        ON public.appointments FOR ALL TO authenticated
        USING (true) WITH CHECK (true)
    $sql$;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customers') THEN
    EXECUTE $sql$
      CREATE POLICY "customers_authenticated_all"
        ON public.customers FOR ALL TO authenticated
        USING (true) WITH CHECK (true)
    $sql$;
  END IF;
END $policy$;

-- ---- 6) barber_style_photos — public read; writes need auth session ---------
DO $policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'barber_style_photos') THEN
    EXECUTE $sql$
      CREATE POLICY "barber_style_photos_select_public"
        ON public.barber_style_photos FOR SELECT TO anon, authenticated USING (true)
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "barber_style_photos_insert_auth"
        ON public.barber_style_photos FOR INSERT TO authenticated WITH CHECK (true)
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "barber_style_photos_update_auth"
        ON public.barber_style_photos FOR UPDATE TO authenticated
        USING (true) WITH CHECK (true)
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "barber_style_photos_delete_auth"
        ON public.barber_style_photos FOR DELETE TO authenticated USING (true)
    $sql$;
  END IF;
END $policy$;

-- Storage policies: run src/db/supabase_rls_storage.sql in Supabase SQL Editor
-- (pooler DATABASE_URL cannot alter storage.objects ownership).

-- ---- 7) Verification query (run manually after apply) -------------------------
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- SELECT * FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
