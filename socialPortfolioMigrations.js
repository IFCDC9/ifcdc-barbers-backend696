import { dbQuery } from "./db.js";

let ready = false;

/**
 * V2 social proof & portfolio schema — idempotent boot migration.
 */
export async function ensureSocialPortfolioSchema() {
  if (ready) return;
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS years_experience INT;`);
  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS public_slug TEXT;`);
  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS portfolio_headline TEXT;`);
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS barbers_public_slug_idx ON barbers (lower(public_slug)) WHERE public_slug IS NOT NULL AND btrim(public_slug) <> '';`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE,
      barber_id TEXT NOT NULL,
      customer_user_id UUID,
      rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS barber_reviews_barber_idx ON barber_reviews (barber_id, created_at DESC);`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_reviews_customer_idx ON barber_reviews (customer_user_id, created_at DESC);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS review_photos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id UUID REFERENCES barber_reviews(id) ON DELETE CASCADE,
      barber_id TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      thumbnail_url TEXT,
      caption TEXT,
      photo_type TEXT NOT NULL DEFAULT 'after',
      style_category TEXT,
      is_30_day_followup BOOLEAN NOT NULL DEFAULT false,
      parent_photo_id UUID REFERENCES review_photos(id) ON DELETE SET NULL,
      like_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS review_photos_barber_idx ON review_photos (barber_id, created_at DESC);`);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS review_photos_category_idx ON review_photos (style_category, created_at DESC) WHERE status = 'published';`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS review_photos_followup_idx ON review_photos (parent_photo_id) WHERE parent_photo_id IS NOT NULL;`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS photo_likes (
      id BIGSERIAL PRIMARY KEY,
      photo_id UUID NOT NULL REFERENCES review_photos(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (photo_id, user_id)
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS photo_likes_user_idx ON photo_likes (user_id, created_at DESC);`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_follows (
      id BIGSERIAL PRIMARY KEY,
      barber_id TEXT NOT NULL,
      follower_user_id UUID NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (barber_id, follower_user_id)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_follows_barber_idx ON barber_follows (barber_id, created_at DESC);`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_follows_follower_idx ON barber_follows (follower_user_id, created_at DESC);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_badges (
      id BIGSERIAL PRIMARY KEY,
      barber_id TEXT NOT NULL,
      badge_key TEXT NOT NULL,
      awarded_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (barber_id, badge_key)
    );
  `);
  await dbQuery(`CREATE INDEX IF NOT EXISTS barber_badges_barber_idx ON barber_badges (barber_id);`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS content_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reporter_user_id UUID,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_notes TEXT,
      reviewed_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS content_reports_status_idx ON content_reports (status, created_at DESC);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS haircut_followup_reminders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE,
      barber_id TEXT NOT NULL,
      customer_user_id UUID,
      customer_email TEXT,
      original_review_id UUID REFERENCES barber_reviews(id) ON DELETE SET NULL,
      remind_at TIMESTAMPTZ NOT NULL,
      reminded_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS haircut_followup_remind_at_idx ON haircut_followup_reminders (remind_at) WHERE status = 'scheduled';`,
  );

  ready = true;
}
