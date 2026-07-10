import { dbQuery } from "./db.js";

/** @returns {Promise<'uuid'|'bigint'|'integer'|'unknown'>} */
export async function getBarbersIdColumnType() {
  try {
    const t = await dbQuery(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'barbers' AND column_name = 'id'
       LIMIT 1`,
    );
    const dt = String(t.rows?.[0]?.data_type || "unknown").toLowerCase();
    if (dt === "uuid") return "uuid";
    if (dt === "bigint" || dt === "integer" || dt === "smallint") return "bigint";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** @returns {Promise<string|null>} */
export async function getTableBarberIdType(tableName) {
  try {
    const t = await dbQuery(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'barber_id'
       LIMIT 1`,
      [tableName],
    );
    return t.rows?.[0]?.data_type ? String(t.rows[0].data_type).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** @returns {Promise<string|null>} */
async function tableBarberIdType(tableName) {
  return getTableBarberIdType(tableName);
}

/**
 * When barbers.id is UUID, migrate legacy BIGINT barber_id FK columns on dependent tables.
 */
export async function alignLegacyBarberFkColumns() {
  const barbersType = await getBarbersIdColumnType();
  if (barbersType !== "uuid") return { aligned: false, reason: "barbers_not_uuid" };

  const tables = ["barber_services", "bookings", "barber_fee_ledger"];
  const results = {};

  for (const tableName of tables) {
    const cur = await getTableBarberIdType(tableName);
    if (cur === "uuid") {
      results[tableName] = "already_uuid";
      continue;
    }
    if (cur !== "bigint") {
      results[tableName] = "skipped";
      continue;
    }

    console.warn(`[migrate] ${tableName}.barber_id is bigint but barbers.id is uuid — aligning to uuid`);

    await dbQuery(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS barber_id_uuid UUID`);

    await dbQuery(`
      UPDATE ${tableName} t
      SET barber_id_uuid = b.id
      FROM barbers b
      WHERE t.barber_id_uuid IS NULL
        AND t.barber_id = 1
        AND lower(trim(b.name)) = 'fade master'
    `);
    await dbQuery(`
      UPDATE ${tableName} t
      SET barber_id_uuid = b.id
      FROM barbers b
      WHERE t.barber_id_uuid IS NULL
        AND t.barber_id = 2
        AND lower(trim(b.name)) = 'clipper king'
    `);

    if (tableName === "bookings") {
      await dbQuery(`
        UPDATE ${tableName} t
        SET barber_id_uuid = b.id
        FROM barbers b
        WHERE t.barber_id_uuid IS NULL
          AND t.barber_name IS NOT NULL
          AND btrim(t.barber_name) <> ''
          AND lower(trim(t.barber_name)) = lower(trim(b.name))
      `);
    }

    const unmigrated = await dbQuery(
      `SELECT COUNT(*)::int AS n FROM ${tableName} WHERE barber_id IS NOT NULL AND barber_id_uuid IS NULL`,
    );
    const n = unmigrated.rows?.[0]?.n ?? 0;
    if (n > 0) {
      console.warn(`[migrate] ${tableName}.barber_id: ${n} row(s) could not map to uuid — keeping bigint column`);
      await dbQuery(`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS barber_id_uuid`);
      results[tableName] = `partial_${n}_unmapped`;
      continue;
    }

    if (tableName === "bookings") {
      await dbQuery(`DROP INDEX IF EXISTS bookings_slot_unique_confirmed_paid`);
      await dbQuery(`DROP INDEX IF EXISTS bookings_barber_id_idx`);
    }
    if (tableName === "barber_fee_ledger") {
      await dbQuery(`DROP INDEX IF EXISTS barber_fee_ledger_barber_id_idx`);
    }

    await dbQuery(`ALTER TABLE ${tableName} DROP COLUMN barber_id`);
    await dbQuery(`ALTER TABLE ${tableName} RENAME COLUMN barber_id_uuid TO barber_id`);
    if (tableName === "bookings") {
      await dbQuery(`ALTER TABLE ${tableName} ALTER COLUMN barber_id SET NOT NULL`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS bookings_barber_id_idx ON bookings (barber_id);`);
      await dbQuery(`
        CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot_unique_confirmed_paid
        ON bookings (barber_id, date, time)
        WHERE booking_status = 'confirmed'
          AND is_paid_booking = true
          AND payment_status IN ('paid', 'paid_full', 'deposit_paid');
      `);
    }
    if (tableName === "barber_fee_ledger") {
      await dbQuery(`CREATE INDEX IF NOT EXISTS barber_fee_ledger_barber_id_idx ON barber_fee_ledger (barber_id);`);
    }

    results[tableName] = "migrated_to_uuid";
  }

  try {
    const { clearBarberColumnTypeCache } = require("./barberIdentity.cjs");
    clearBarberColumnTypeCache();
  } catch {
    /* optional */
  }

  return { aligned: true, results };
}

/**
 * Recreate schedule tables when barber_id column type does not match barbers.id (UUID vs BIGINT).
 */
export async function ensureBarberScheduleSchema(barberIdType) {
  const want = barberIdType === "uuid" ? "uuid" : "bigint";
  const barberCol = want === "uuid" ? "UUID NOT NULL" : "BIGINT NOT NULL";

  const cur = await tableBarberIdType("barber_availability");
  if (cur && cur !== want) {
    console.warn(`[migrate] barber_availability barber_id is ${cur}, barbers.id is ${want} — recreating schedule tables`);
    await dbQuery(`DROP TABLE IF EXISTS barber_availability_breaks CASCADE`);
    await dbQuery(`DROP TABLE IF EXISTS barber_blocked_dates CASCADE`);
    await dbQuery(`DROP TABLE IF EXISTS barber_availability CASCADE`);
  }

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_availability (
      id BIGSERIAL PRIMARY KEY,
      barber_id ${barberCol},
      day_of_week SMALLINT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      is_off BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_availability_barber_day_idx ON barber_availability (barber_id, day_of_week);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_availability_breaks (
      id BIGSERIAL PRIMARY KEY,
      barber_id ${barberCol},
      day_of_week SMALLINT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_availability_breaks_barber_day_idx ON barber_availability_breaks (barber_id, day_of_week);`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_blocked_dates (
      id BIGSERIAL PRIMARY KEY,
      barber_id ${barberCol},
      blocked_date DATE NOT NULL,
      note TEXT,
      UNIQUE (barber_id, blocked_date)
    );
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS barber_blocked_dates_barber_idx ON barber_blocked_dates (barber_id, blocked_date);`,
  );

  await dbQuery(`ALTER TABLE barber_blocked_dates ADD COLUMN IF NOT EXISTS client_reason TEXT;`);
  await dbQuery(`ALTER TABLE barber_blocked_dates ADD COLUMN IF NOT EXISTS return_date DATE;`);
  await dbQuery(`ALTER TABLE barber_blocked_dates ADD COLUMN IF NOT EXISTS client_message TEXT;`);

  const settingsCur = await tableBarberIdType("barber_settings");
  if (settingsCur && settingsCur !== want) {
    console.warn(`[migrate] barber_settings barber_id is ${settingsCur}, barbers.id is ${want} — recreating barber_settings`);
    await dbQuery(`DROP TABLE IF EXISTS barber_settings CASCADE`);
  }

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS barber_settings (
      id BIGSERIAL PRIMARY KEY,
      barber_id ${barberCol} UNIQUE,
      theme_color TEXT NOT NULL DEFAULT '#FFD700',
      booking_deposit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'paypal',
      aura_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      aura_voice_type TEXT NOT NULL DEFAULT 'Polly.Joanna',
      language TEXT NOT NULL DEFAULT 'en',
      appointment_interval_minutes INT NOT NULL DEFAULT 30,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      subscription_tier TEXT NOT NULL DEFAULT 'free',
      billing_provider TEXT NOT NULL DEFAULT 'none'
    );
  `);

  await dbQuery(`
    ALTER TABLE barber_settings
      ADD COLUMN IF NOT EXISTS appointment_interval_minutes INT NOT NULL DEFAULT 30;
  `);
  await dbQuery(`
    ALTER TABLE barber_settings
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';
  `);
}

/** Demo schedule for legacy catalog barbers — skipped in production. */
export async function seedCatalogBarberAvailability() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const allowDemo = String(process.env.IFCDC_ALLOW_DEMO_SEED || "").trim() === "1";
  if (isProd && !allowDemo) {
    return { seeded: false, reason: "production_skip" };
  }

  await dbQuery(`
    DELETE FROM barber_availability a
    USING barbers b
    WHERE a.barber_id = b.id
      AND lower(trim(b.name)) IN ('fade master', 'clipper king');
  `);

  await dbQuery(`
    INSERT INTO barber_availability (barber_id, day_of_week, start_time, end_time, is_off)
    SELECT b.id, d.dow, '09:00'::time, '01:00'::time, false
    FROM barbers b
    CROSS JOIN (SELECT generate_series(0, 6) AS dow) d
    WHERE lower(trim(b.name)) IN ('fade master', 'clipper king');
  `);

  await dbQuery(`
    INSERT INTO barber_settings (barber_id, subscription_tier, appointment_interval_minutes, timezone)
    SELECT b.id, 'pro', 30, 'America/New_York'
    FROM barbers b
    WHERE lower(trim(b.name)) IN ('fade master', 'clipper king')
    ON CONFLICT (barber_id) DO UPDATE SET
      appointment_interval_minutes = EXCLUDED.appointment_interval_minutes,
      timezone = EXCLUDED.timezone;
  `);

  const count = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM barber_availability a
     JOIN barbers b ON b.id = a.barber_id
     WHERE lower(trim(b.name)) IN ('fade master', 'clipper king')`,
  );
  console.log("[migrate] catalog barber availability rows:", count.rows?.[0]?.n ?? 0);
}
