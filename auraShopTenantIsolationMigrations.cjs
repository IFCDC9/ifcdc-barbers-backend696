/**
 * Production-critical: normalize barbers.business_id → BIGINT, backfill to primary
 * IFCDC shop, add FK + index. Additive shop hours fields for Founder voice updates.
 * Never deletes barber rows or overwrites names/profiles.
 */
async function resolvePrimaryIfcdcShopId(dbQuery) {
  const r = await dbQuery(
    `SELECT id FROM businesses
     WHERE id = 1
        OR lower(name) LIKE '%ifcdc%'
        OR public_phone_e164 = '+19895141064'
        OR phone = '+19895141064'
        OR regexp_replace(coalesce(phone,''), '\\D', '', 'g') = '19895141064'
     ORDER BY CASE WHEN id = 1 THEN 0 WHEN lower(name) LIKE '%ifcdc barbers%' THEN 1 ELSE 2 END, id ASC
     LIMIT 1`,
  );
  if (r.rows?.[0]?.id != null) return Number(r.rows[0].id);
  const any = await dbQuery(`SELECT id FROM businesses ORDER BY id ASC LIMIT 1`);
  return any.rows?.[0]?.id != null ? Number(any.rows[0].id) : null;
}

async function ensureAuraShopTenantIsolation(dbQuery) {
  if (typeof dbQuery !== "function") return { ok: false, reason: "no_db" };

  // Shop-level hours / closure (for Founder spoken updates)
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS operating_hours_json JSONB`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS holiday_hours_json JSONB`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS temporary_closed BOOLEAN DEFAULT FALSE`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS temporary_closed_until TIMESTAMPTZ`);
  await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS temporary_closed_reason TEXT`);

  const primaryId = await resolvePrimaryIfcdcShopId(dbQuery);
  if (primaryId == null || !Number.isFinite(primaryId)) {
    console.warn("[tenant-isolation] no businesses row — skip barbers.business_id harden");
    return { ok: false, reason: "no_primary_shop" };
  }

  // Ensure column exists
  await dbQuery(`ALTER TABLE barbers ADD COLUMN IF NOT EXISTS business_id TEXT`);

  // Detect current type
  const typeR = await dbQuery(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'barbers' AND column_name = 'business_id'`,
  );
  const dataType = String(typeR.rows?.[0]?.data_type || "").toLowerCase();

  if (dataType === "text" || dataType === "character varying") {
    // Backfill legacy / invalid → primary IFCDC shop; keep valid numeric IDs that exist
    await dbQuery(
      `UPDATE barbers b
       SET business_id = $1::text
       WHERE b.business_id IS NULL
          OR btrim(b.business_id::text) = ''
          OR lower(btrim(b.business_id::text)) IN ('default', 'legacy', 'tenant', 'null', 'none')
          OR btrim(b.business_id::text) = '0'
          OR b.business_id::text !~ '^[0-9]+$'
          OR NOT EXISTS (
               SELECT 1 FROM businesses biz WHERE biz.id::text = btrim(b.business_id::text)
             )`,
      [String(primaryId)],
    );

    // Drop TEXT default before cast (Postgres cannot auto-cast column defaults)
    try {
      await dbQuery(`ALTER TABLE barbers ALTER COLUMN business_id DROP DEFAULT`);
    } catch (_) {
      /* no default */
    }

    // Convert to BIGINT
    await dbQuery(
      `ALTER TABLE barbers
         ALTER COLUMN business_id TYPE BIGINT
         USING NULLIF(btrim(business_id::text), '')::bigint`,
    );

    // Re-apply numeric default pointing at primary IFCDC shop
    await dbQuery(`ALTER TABLE barbers ALTER COLUMN business_id SET DEFAULT $1::bigint`, [
      primaryId,
    ]).catch(async () => {
      await dbQuery(
        `ALTER TABLE barbers ALTER COLUMN business_id SET DEFAULT ${Number(primaryId)}`,
      );
    });
  } else if (dataType === "bigint" || dataType === "integer" || dataType === "numeric") {
    await dbQuery(
      `UPDATE barbers b
       SET business_id = $1::bigint
       WHERE b.business_id IS NULL
          OR b.business_id = 0
          OR NOT EXISTS (SELECT 1 FROM businesses biz WHERE biz.id = b.business_id)`,
      [primaryId],
    );
  }

  // NOT NULL after backfill
  await dbQuery(`UPDATE barbers SET business_id = $1::bigint WHERE business_id IS NULL`, [primaryId]);
  try {
    await dbQuery(`ALTER TABLE barbers ALTER COLUMN business_id SET NOT NULL`);
  } catch (e) {
    console.warn("[tenant-isolation] NOT NULL skipped:", e?.message || e);
  }

  // Index
  await dbQuery(`CREATE INDEX IF NOT EXISTS barbers_business_id_idx ON barbers (business_id)`);

  // FK — prevent orphaned barbers pointing at missing shops
  try {
    await dbQuery(`
      DO $fk$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.barbers'::regclass
            AND conname = 'barbers_business_id_fkey'
        ) THEN
          ALTER TABLE barbers
            ADD CONSTRAINT barbers_business_id_fkey
            FOREIGN KEY (business_id) REFERENCES businesses(id)
            ON DELETE RESTRICT;
        END IF;
      END $fk$;
    `);
  } catch (e) {
    console.warn("[tenant-isolation] barbers_business_id_fkey:", e?.message || e);
  }

  // Align barber_services.business_id from parent barber when null
  try {
    await dbQuery(`ALTER TABLE barber_services ADD COLUMN IF NOT EXISTS business_id BIGINT`);
    await dbQuery(`
      UPDATE barber_services s
         SET business_id = b.business_id
        FROM barbers b
       WHERE s.business_id IS NULL
         AND (
           s.barber_id::text = b.id::text
           OR s.barber_id::text = b.id::text
         )
    `);
    // For UUID barber ids stored as text in services
    await dbQuery(`
      UPDATE barber_services s
         SET business_id = b.business_id
        FROM barbers b
       WHERE s.business_id IS NULL
         AND s.barber_id::text = b.id::text
    `).catch(() => {});
  } catch (e) {
    console.warn("[tenant-isolation] barber_services backfill:", e?.message || e);
  }

  const stats = await dbQuery(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE business_id = $1)::int AS primary_shop,
            COUNT(*) FILTER (WHERE business_id IS NULL)::int AS still_null
     FROM barbers`,
    [primaryId],
  );

  console.log("[tenant-isolation] barbers.business_id hardened", {
    primaryShopId: primaryId,
    ...(stats.rows?.[0] || {}),
  });

  return { ok: true, primaryShopId: primaryId, stats: stats.rows?.[0] || null };
}

module.exports = {
  ensureAuraShopTenantIsolation,
  resolvePrimaryIfcdcShopId,
};
