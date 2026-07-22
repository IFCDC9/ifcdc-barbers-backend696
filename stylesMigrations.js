import { dbQuery } from "./db.js";
import { createRequire } from "node:module";
import { STYLE_CATEGORIES } from "./discoverCategories.js";

const requireCjs = createRequire(import.meta.url);
const { ensureBarberStyleGalleryTable } = requireCjs("./styleGalleryStore.cjs");

export { STYLE_CATEGORIES };

export async function ensureStylesTables() {
  await dbQuery(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS styles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      barber_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      image_url TEXT NOT NULL,
      category TEXT DEFAULT 'other',
      price NUMERIC(10,2) NOT NULL DEFAULT 25,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`ALTER TABLE styles ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);`);
  await dbQuery(`UPDATE styles SET price = 25 WHERE price IS NULL;`);
  await dbQuery(
    `ALTER TABLE styles ALTER COLUMN price SET DEFAULT 25;`
  );
  await dbQuery(
    `DO $$ BEGIN
      ALTER TABLE styles ALTER COLUMN price SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;`
  );

  await dbQuery(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'styles_category_allowed'
      ) THEN
        ALTER TABLE styles
          ADD CONSTRAINT styles_category_allowed
          CHECK (category IN ('fades','tapers','waves','braids','beard work','kids cuts','designs','other'));
      END IF;
    END $$;
  `);

  await dbQuery(`CREATE INDEX IF NOT EXISTS styles_barber_id_idx ON styles (barber_id);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS styles_created_at_idx ON styles (created_at DESC);`);
  await dbQuery(`ALTER TABLE styles ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE;`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS styles_published_idx ON styles (is_published) WHERE is_published = true;`);

  await ensureBarberStyleGalleryTable(dbQuery);

  await dbQuery(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'barber_style_gallery'
          AND policyname = 'barber_style_gallery_public_read'
      ) THEN
        CREATE POLICY barber_style_gallery_public_read ON barber_style_gallery
          FOR SELECT TO anon, authenticated
          USING (is_published = true);
      END IF;
    END $$;
  `);
}

export async function seedSampleStylesIfEmpty() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const allowDemo = String(process.env.IFCDC_ALLOW_DEMO_SEED || "").trim() === "1";
  if (isProd && !allowDemo) {
    return { seeded: false, reason: "production_skip" };
  }

  const r = await dbQuery(`SELECT COUNT(*)::int AS n FROM styles;`);
  const n = r.rows?.[0]?.n ?? 0;
  if (n > 0) return { seeded: false, reason: "non_empty" };

  // Seed with stable remote images (works in dev immediately).
  const rows = [
    {
      barber_id: 1,
      title: "Skin Fade + Lineup",
      description: "Clean fade with sharp lineup and texture on top.",
      category: "fades",
      price: 45,
      image_url:
        "https://images.unsplash.com/photo-1520975958225-b44b457768a1?auto=format&fit=crop&w=1200&q=70",
    },
    {
      barber_id: 1,
      title: "Low Taper",
      description: "Low taper with natural finish — everyday clean.",
      category: "tapers",
      price: 40,
      image_url:
        "https://images.unsplash.com/photo-1593702281542-9e9c9d3f4d2c?auto=format&fit=crop&w=1200&q=70",
    },
    {
      barber_id: 2,
      title: "Beard Work + Shape Up",
      description: "Beard sculpted + crisp cheek lines and shape up.",
      category: "beard work",
      price: 35,
      image_url:
        "https://images.unsplash.com/photo-1517832606299-7ae9b720a186?auto=format&fit=crop&w=1200&q=70",
    },
  ];

  for (const s of rows) {
    await dbQuery(
      `INSERT INTO styles (barber_id, title, description, image_url, category, price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.barber_id, s.title, s.description, s.image_url, s.category, s.price ?? 35]
    );
  }
  return { seeded: true, count: rows.length };
}

