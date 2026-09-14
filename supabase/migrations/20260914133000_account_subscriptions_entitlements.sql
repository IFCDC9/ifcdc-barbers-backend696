-- NOT APPLIED TO PRODUCTION (2026-09-14)
-- Project: supabase-emerald-kite (vtkxuagevtiwtoheomjt)
-- Name: account_subscriptions_entitlements
-- Additive only: catalog + entitlements + event log.
-- Does NOT start trials, charge users, rewrite plans, or delete historical subscription rows.
-- Apply only after Tessa approves SQL (same process as phone enrollment).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.platform_product_catalog (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_type TEXT NOT NULL,
  plan_key TEXT,
  list_price_usd NUMERIC(10,2) NOT NULL,
  billing_period TEXT,
  subscription_group TEXT,
  rank INTEGER NOT NULL DEFAULT 0,
  intro_offer TEXT,
  promo_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, product_id)
);

CREATE TABLE IF NOT EXISTS public.account_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  business_id BIGINT,
  plan_key TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  store_platform TEXT,
  store_product_id TEXT,
  store_original_transaction_id TEXT,
  store_purchase_token TEXT,
  store_environment TEXT,
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  intro_used BOOLEAN NOT NULL DEFAULT FALSE,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.app_access_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  store_purchase_token TEXT,
  store_original_transaction_id TEXT,
  store_environment TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restored_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_subscription_id UUID,
  user_id UUID,
  business_id BIGINT,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  notification_uuid TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_subscriptions_user_idx ON public.account_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS account_subscriptions_business_idx ON public.account_subscriptions (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_subscriptions_store_original_uidx
  ON public.account_subscriptions (store_platform, store_original_transaction_id)
  WHERE store_original_transaction_id IS NOT NULL AND btrim(store_original_transaction_id) <> '';
CREATE INDEX IF NOT EXISTS app_access_entitlements_user_idx ON public.app_access_entitlements (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_notification_uidx
  ON public.subscription_events (provider, notification_uuid)
  WHERE notification_uuid IS NOT NULL AND btrim(notification_uuid) <> '';

ALTER TABLE public.platform_product_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_access_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_product_catalog FROM anon, authenticated;
REVOKE ALL ON public.account_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.app_access_entitlements FROM anon, authenticated;
REVOKE ALL ON public.subscription_events FROM anon, authenticated;

INSERT INTO public.platform_product_catalog
  (platform, product_id, product_type, plan_key, list_price_usd, billing_period, subscription_group, rank, intro_offer, promo_notes)
VALUES
  ('apple', 'ifcdc.barbers.multilocation.monthly', 'subscription', 'multilocation', 59.99, 'P1M', 'IFCDC Barbers Pro Plans', 3, 'free_first_month', 'confirm App Store Connect promotional offer IDs with Tessa — Multi-Location $29.99/3mo'),
  ('apple', 'ifcdc.barbers.shop.monthly', 'subscription', 'shop', 29.99, 'P1M', 'IFCDC Barbers Pro Plans', 2, 'free_first_month', 'confirm App Store Connect promotional offer IDs with Tessa — Shop $14.99/3mo'),
  ('apple', 'ifcdc.barbers.individual.monthly', 'subscription', 'individual', 9.99, 'P1M', 'IFCDC Barbers Pro Plans', 1, 'free_first_month', 'confirm App Store Connect promotional offer IDs with Tessa — Individual $4.99/3mo'),
  ('google', 'ifcdc.barbers.multilocation.monthly', 'subscription', 'multilocation', 59.99, 'P1M', 'IFCDC Barbers Pro Plans', 3, 'free_first_month', 'confirm with Tessa before production'),
  ('google', 'ifcdc.barbers.shop.monthly', 'subscription', 'shop', 29.99, 'P1M', 'IFCDC Barbers Pro Plans', 2, 'free_first_month', 'confirm with Tessa before production'),
  ('google', 'ifcdc.barbers.individual.monthly', 'subscription', 'individual', 9.99, 'P1M', 'IFCDC Barbers Pro Plans', 1, 'free_first_month', 'confirm with Tessa before production'),
  ('google', 'ifcdc.barbers.access', 'app_access', NULL, 0.99, NULL, NULL, 0, NULL, 'confirm with Tessa before production — configurable GOOGLE_ACCESS_PRODUCT_ID')
ON CONFLICT (platform, product_id) DO NOTHING;
