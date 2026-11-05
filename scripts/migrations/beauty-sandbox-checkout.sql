BEGIN;
CREATE TABLE IF NOT EXISTS beauty_sandbox_orders (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES app_users(id),
  request_key uuid NOT NULL,
  basket_hash text NOT NULL,
  partner_client_id text NOT NULL,
  partner_id text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','paypal_created','capture_pending','paid','review_required','cancelled')),
  quote jsonb NOT NULL,
  bindings jsonb NOT NULL,
  paypal_order_id text UNIQUE,
  approval_url text,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE(buyer_id,request_key)
);
CREATE TABLE IF NOT EXISTS beauty_sandbox_captures (
  capture_id text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES beauty_sandbox_orders(id),
  seller_id text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS beauty_sandbox_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES beauty_sandbox_orders(id),
  event text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beauty_sandbox_orders_buyer_created ON beauty_sandbox_orders(buyer_id,created_at DESC);
ALTER TABLE beauty_sandbox_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE beauty_sandbox_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE beauty_sandbox_order_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON beauty_sandbox_orders,beauty_sandbox_captures,beauty_sandbox_order_events FROM PUBLIC;
COMMIT;
