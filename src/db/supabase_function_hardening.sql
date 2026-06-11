-- =============================================================================
-- IFCDC Barbers — Supabase function hardening (search_path + EXECUTE grants)
-- Project: vtkxuagevtiwtoheomjt (supabase-emerald-kite)
--
-- Fixes Security Advisor: function_search_path_mutable
-- Hardens SECURITY DEFINER RPCs that bypass RLS on loyalty_points.
--
-- Safe to re-run (idempotent ALTER / REVOKE / GRANT).
-- =============================================================================

-- ---- 1) Pin search_path on all custom plpgsql functions ---------------------
ALTER FUNCTION public.add_loyalty_points(uuid, uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_barber_follower_count(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.get_nearby_barbers(numeric, numeric, numeric, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.haversine_distance(numeric, numeric, numeric, numeric)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.record_visit(uuid, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.redeem_free_haircut(uuid, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.redeem_loyalty_points(uuid, uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.update_barber_rating()
  SET search_path = public, pg_temp;

-- ---- 2) Lock down SECURITY DEFINER loyalty RPCs (bypass RLS) ---------------
-- IFCDC uses Node API (postgres pool) for bookings — not PostgREST RPCs.
-- Anon/authenticated must not execute definer functions on loyalty_points.

REVOKE ALL ON FUNCTION public.add_loyalty_points(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_visit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_free_haircut(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_loyalty_points(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.add_loyalty_points(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_visit(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_free_haircut(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, uuid, integer) TO service_role;

-- Trigger function: not callable via PostgREST; revoke anon for defense in depth
REVOKE ALL ON FUNCTION public.update_barber_rating() FROM PUBLIC, anon;

-- Read-only helpers: search_path pinned; RLS still applies (not SECURITY DEFINER)
REVOKE ALL ON FUNCTION public.get_nearby_barbers(numeric, numeric, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_barber_follower_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.haversine_distance(numeric, numeric, numeric, numeric) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_nearby_barbers(numeric, numeric, numeric, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_barber_follower_count(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.haversine_distance(numeric, numeric, numeric, numeric) TO anon, authenticated, service_role;
