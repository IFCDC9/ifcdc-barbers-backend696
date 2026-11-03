BEGIN;
CREATE TABLE IF NOT EXISTS beauty_catalog_state (
  id integer PRIMARY KEY CHECK (id = 1),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  catalog jsonb NOT NULL DEFAULT '{"sellers":[],"products":[]}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS beauty_catalog_audit (
  id bigserial PRIMARY KEY,
  actor_id text NOT NULL,
  revision integer NOT NULL,
  catalog jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE beauty_catalog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE beauty_catalog_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON beauty_catalog_state, beauty_catalog_audit FROM PUBLIC;
-- No browser policies: access exclusively through the server database role.
INSERT INTO beauty_catalog_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMIT;
