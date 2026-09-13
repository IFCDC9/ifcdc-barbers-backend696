-- ALREADY APPLIED ON PRODUCTION (2026-09-13) via MCP apply_migration
-- Project: supabase-emerald-kite (vtkxuagevtiwtoheomjt)
-- Name: phone_enrollment_unique_verified
-- Additive only: enrollment OTP columns + unique verified-phone index.
-- Does not modify management_assignments, Super Admin, or user phone values.

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS phone_enroll_otp_hash TEXT;
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS phone_enroll_otp_expires_at TIMESTAMPTZ;
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS phone_enroll_phone_e164 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_verified_phone_e164_uidx
  ON public.app_users (phone_e164)
  WHERE phone_verified IS TRUE
    AND phone_e164 IS NOT NULL
    AND btrim(phone_e164) <> '';
