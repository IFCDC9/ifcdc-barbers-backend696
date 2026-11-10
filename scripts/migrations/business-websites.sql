CREATE TABLE IF NOT EXISTS business_websites (
 site_key text PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('platform','shop','barber')),
 subject_id text,
 draft jsonb NOT NULL,
 published jsonb,
 revision integer NOT NULL DEFAULT 1,
 suspended boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz
);
CREATE TABLE IF NOT EXISTS business_website_media (
 id uuid PRIMARY KEY,
 site_key text NOT NULL REFERENCES business_websites(site_key),
 storage_path text NOT NULL UNIQUE,
 mime text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business_websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_website_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON business_websites,business_website_media FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON business_websites,business_website_media FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON business_websites,business_website_media FROM authenticated; END IF;
END $$;
