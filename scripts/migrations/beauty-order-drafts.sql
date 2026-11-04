BEGIN;
CREATE TABLE IF NOT EXISTS beauty_order_drafts (
 id uuid PRIMARY KEY,
 buyer_id uuid NOT NULL REFERENCES app_users(id),
 request_key text NOT NULL,
 basket_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
 quote jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
 UNIQUE (buyer_id,request_key)
);
CREATE INDEX IF NOT EXISTS beauty_order_drafts_buyer_created ON beauty_order_drafts(buyer_id,created_at DESC);
ALTER TABLE beauty_order_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON beauty_order_drafts FROM PUBLIC;
COMMIT;
