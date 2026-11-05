BEGIN;
ALTER TABLE beauty_sandbox_orders ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none' CHECK(refund_status IN ('none','requested','pending','completed','review_required','external_review'));
ALTER TABLE beauty_sandbox_orders ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'processing' CHECK(fulfillment_status IN ('processing','ready','collected','halted'));
ALTER TABLE beauty_sandbox_orders ADD COLUMN IF NOT EXISTS payment_review boolean NOT NULL DEFAULT false;
ALTER TABLE beauty_sandbox_orders ADD COLUMN IF NOT EXISTS inventory_restocked boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS beauty_sandbox_refunds (
 capture_id text PRIMARY KEY REFERENCES beauty_sandbox_captures(capture_id),
 order_id uuid NOT NULL REFERENCES beauty_sandbox_orders(id),
 request_id uuid NOT NULL UNIQUE,
 merchant_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 platform_fee_cents bigint NOT NULL CHECK(platform_fee_cents>=0),
 provider_refund_id text UNIQUE,
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','pending','completed','review_required')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz
);
CREATE TABLE IF NOT EXISTS beauty_sandbox_webhook_events (
 partner_client_id text NOT NULL,
 partner_id text NOT NULL,
 event_id text NOT NULL,
 event_type text NOT NULL,
 event_hash text NOT NULL,
 resource_summary jsonb NOT NULL,
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','processing','processed','failed','unmatched')),
 lease_token uuid,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 verified_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 PRIMARY KEY(partner_client_id,partner_id,event_id)
);
ALTER TABLE beauty_sandbox_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE beauty_sandbox_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON beauty_sandbox_refunds,beauty_sandbox_webhook_events FROM PUBLIC;
COMMIT;
