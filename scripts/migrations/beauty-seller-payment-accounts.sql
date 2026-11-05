BEGIN;
CREATE TABLE IF NOT EXISTS beauty_seller_payment_accounts (
  seller_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  partner_client_id text NOT NULL,
  partner_id text NOT NULL,
  tracking_id uuid NOT NULL UNIQUE,
  merchant_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','account_authorized')),
  payments_receivable boolean NOT NULL DEFAULT false,
  email_confirmed boolean NOT NULL DEFAULT false,
  permissions_granted boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  PRIMARY KEY (seller_id,environment,partner_client_id,partner_id)
);
ALTER TABLE beauty_seller_payment_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON beauty_seller_payment_accounts FROM PUBLIC;
COMMIT;
