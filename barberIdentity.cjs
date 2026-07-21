/**
 * Canonical barber identity resolution — never casts UUID into bigint.
 * Used by booking checkout, services catalog, slot engine, and fee ledger.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Production uses Postgres only — no hardcoded demo barbers. */
const BOOKING_BARBER_CATALOG = [];

const BARBER_RESOLVE_MSG = "Unable to confirm barber. Please reselect barber.";

let columnTypeCache = null;

function stripQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Runtime guard: UUID barber ids contain "-". */
function isUuidBarberId(v) {
  const s = String(v ?? "").trim();
  return s.includes("-") && UUID_RE.test(s);
}

function barberIdInputType(v) {
  const s = String(v ?? "").trim();
  if (!s) return "empty";
  if (isUuidBarberId(s)) return "uuid";
  if (/^\d+$/.test(s)) return "numeric";
  return "name";
}

function numericCatalogBarberId(barberName) {
  const label = String(barberName || "").trim().toLowerCase();
  const hit = BOOKING_BARBER_CATALOG.find(
    (b) => String(b.name || "").trim().toLowerCase() === label,
  );
  return hit?.bookingBarberId ?? null;
}

function normalizeIdentityInput(input, barberName = "") {
  if (input != null && typeof input === "object" && !Array.isArray(input)) {
    const id =
      input.id ??
      input.barberId ??
      input.barber_id ??
      input.uuid ??
      input.barberUuid ??
      input.barber_uuid;
    const name = input.name ?? input.barberName ?? input.barber_name ?? barberName;
    return {
      idRaw: id != null ? String(id).trim() : "",
      nameRaw: stripQuotes(name),
    };
  }
  const raw = stripQuotes(input);
  const nameRaw = stripQuotes(barberName);
  if (!raw) return { idRaw: "", nameRaw };
  const kind = barberIdInputType(raw);
  if (kind === "uuid" || kind === "numeric") return { idRaw: raw, nameRaw: nameRaw || "" };
  return { idRaw: "", nameRaw: raw || nameRaw };
}

async function getTableBarberIdType(dbQuery, tableName) {
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

async function getBarberColumnTypes(dbQuery) {
  if (columnTypeCache) return columnTypeCache;
  let barbersId = "unknown";
  try {
    const mod = await import("./barberScheduleMigrations.js");
    barbersId = await mod.getBarbersIdColumnType();
  } catch {
    /* optional */
  }
  columnTypeCache = {
    barbersId,
    bookings: await getTableBarberIdType(dbQuery, "bookings"),
    barberServices: await getTableBarberIdType(dbQuery, "barber_services"),
    barberSettings: await getTableBarberIdType(dbQuery, "barber_settings"),
    barberFeeLedger: await getTableBarberIdType(dbQuery, "barber_fee_ledger"),
  };
  return columnTypeCache;
}

function clearBarberColumnTypeCache() {
  columnTypeCache = null;
}

async function ensureBarberRowForServices(dbQuery, name, profileImage = "") {
  const nameRaw = String(name || "").trim();
  if (!nameRaw) return null;
  const existing = await dbQuery(
    `SELECT id, name, business_id FROM barbers WHERE lower(trim(name)) = lower(trim($1)) ORDER BY id ASC LIMIT 1`,
    [nameRaw],
  );
  if (existing.rows?.[0]) return existing.rows[0];
  const ins = await dbQuery(
    `INSERT INTO barbers (name, profile_image, bio, location) VALUES ($1, $2, '', '') RETURNING id, name, business_id`,
    [nameRaw, profileImage || ""],
  );
  return ins.rows?.[0] || null;
}

async function lookupBarberRow(dbQuery, { idRaw, nameRaw }) {
  if (idRaw) {
    const byId = await dbQuery(
      `SELECT id, name, business_id FROM barbers WHERE id::text = $1 LIMIT 1`,
      [idRaw],
    );
    if (byId.rows?.[0]) return byId.rows[0];
  }

  if (nameRaw) {
    return ensureBarberRowForServices(dbQuery, nameRaw, "");
  }

  return null;
}

/**
 * @param {*} input uuid | numeric id | barber object | name string
 * @param {string} [barberName]
 * @returns {Promise<{ barberDbId: number|null, barberUuid: string|null, barberName: string, businessId: number|null, barberRow: object, serviceBarberKey: number|string|null } | null>}
 */
async function resolveBarberIdentity(dbQuery, input, barberName = "") {
  const { idRaw, nameRaw } = normalizeIdentityInput(input, barberName);
  if (!idRaw && !nameRaw) return null;

  const inputType = idRaw ? barberIdInputType(idRaw) : nameRaw ? "name" : "empty";
  console.log(`[booking] barberIdType=${inputType}`);

  const barberRow = await lookupBarberRow(dbQuery, { idRaw, nameRaw });
  if (!barberRow) return null;

  const resolvedName = String(barberRow.name || nameRaw || "").trim();
  if (!resolvedName) return null;

  const rawId = barberRow.id;
  const barberUuid = isUuidBarberId(rawId) ? String(rawId).trim() : null;

  let barberDbId = null;
  if (typeof rawId === "number" && Number.isFinite(rawId)) {
    barberDbId = rawId;
  } else if (typeof rawId === "string" && /^\d+$/.test(rawId)) {
    barberDbId = Number(rawId);
  } else {
    barberDbId = numericCatalogBarberId(resolvedName);
  }

  const bookingsCol = await getTableBarberIdType(dbQuery, "bookings");
  const servicesCol = await getTableBarberIdType(dbQuery, "barber_services");

  let serviceBarberKey = null;
  if (servicesCol === "uuid") {
    serviceBarberKey = barberUuid;
  } else {
    serviceBarberKey = barberDbId ?? numericCatalogBarberId(resolvedName);
  }

  const bookingResolvable =
    bookingsCol === "uuid"
      ? Boolean(barberUuid)
      : barberDbId != null && Number.isFinite(barberDbId);

  if (!serviceBarberKey || !bookingResolvable) return null;

  if (servicesCol !== "uuid") {
    assertNotUuidForBigintBarberId(serviceBarberKey, "barber_services", "resolveBarberIdentity");
  }

  let businessId = null;
  try {
    const { resolveNumericBusinessId } = await import("./businessIdResolve.js");
    businessId = await resolveNumericBusinessId(barberRow.business_id, dbQuery);
  } catch (error) {
    console.warn("[booking] businessId resolve failed:", error?.message || error);
    const fallback = barberRow.business_id != null ? Number(barberRow.business_id) : null;
    businessId = Number.isFinite(fallback) ? fallback : null;
  }

  console.log(`[booking] resolvedDbId=${barberDbId ?? "—"} resolvedUuid=${barberUuid ?? "—"}`);

  return {
    barberDbId: barberDbId != null && Number.isFinite(barberDbId) ? barberDbId : null,
    barberUuid,
    barberName: resolvedName,
    businessId,
    barberRow,
    serviceBarberKey,
  };
}

/** Pick the correct barber_id value for a target table column type. */
async function barberIdForTable(dbQuery, tableName, resolved) {
  if (!resolved) return null;
  const colType = await getTableBarberIdType(dbQuery, tableName);
  if (colType === "uuid") {
    return resolved.barberUuid || null;
  }
  const numeric = resolvedBarberDbIdOnly(resolved);
  if (numeric != null) return numeric;
  return null;
}

function scheduleBarberIdFromResolved(resolved, barbersIdType) {
  if (barbersIdType === "uuid" && resolved.barberUuid) return resolved.barberUuid;
  const numeric = resolvedBarberDbIdOnly(resolved);
  if (numeric != null) return numeric;
  return null;
}

/** Coerce any barber id input before schedule/booking queries — never pass UUID to bigint columns. */
async function coerceBarberIdForTable(dbQuery, tableName, barberIdInput, barberName = "") {
  if (barberIdInput == null || String(barberIdInput).trim() === "") return null;
  const raw = String(barberIdInput).trim();
  const colType = await getTableBarberIdType(dbQuery, tableName);

  if (colType === "uuid") {
    if (isUuidBarberId(raw)) return raw;
    const resolved = await resolveBarberIdentity(dbQuery, raw, barberName);
    return resolved?.barberUuid || null;
  }

  if (isUuidBarberId(raw)) {
    const resolved = await resolveBarberIdentity(dbQuery, raw, barberName);
    const numeric = resolvedBarberDbIdOnly(resolved);
    return numeric;
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  const resolved = await resolveBarberIdentity(dbQuery, raw, barberName);
  return resolvedBarberDbIdOnly(resolved);
}

function isBarberIdentityDbError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "").toLowerCase();
  return code === "22P02" || msg.includes("invalid input syntax") || msg.includes("bigint = uuid");
}

function logDbInsertDebug(ctx) {
  console.log("[DB INSERT DEBUG]", ctx);
}

/** Reject UUID values bound to BIGINT barber_id columns. */
function assertNotUuidForBigintBarberId(value, tableName, route = "") {
  if (value != null && isUuidBarberId(value)) {
    logDbInsertDebug({
      route,
      table: tableName,
      blocked: true,
      barber_id: value,
      reason: "UUID blocked for bigint barber_id",
    });
    const err = new Error(`UUID barber_id blocked for ${tableName}`);
    err.code = "barber_uuid_bigint_blocked";
    throw err;
  }
  return value;
}

/**
 * Numeric barber id for BIGINT columns only — never returns UUID.
 * @returns {number|null}
 */
function resolvedBarberDbIdOnly(resolved) {
  if (!resolved) return null;
  const n = resolved.barberDbId;
  if (n != null && Number.isFinite(n) && !isUuidBarberId(n)) return n;
  return null;
}

function logBookingInsertSuccess(bookingId) {
  console.log(`[booking] insertSuccess bookingId=${bookingId ?? "—"}`);
}

module.exports = {
  BOOKING_BARBER_CATALOG,
  BARBER_RESOLVE_MSG,
  stripQuotes,
  isUuidBarberId,
  barberIdInputType,
  numericCatalogBarberId,
  normalizeIdentityInput,
  getTableBarberIdType,
  getBarberColumnTypes,
  clearBarberColumnTypeCache,
  ensureBarberRowForServices,
  lookupBarberRow,
  resolveBarberIdentity,
  resolveBarberForBooking: resolveBarberIdentity,
  resolvedBarberDbIdOnly,
  barberIdForTable,
  scheduleBarberIdFromResolved,
  coerceBarberIdForTable,
  isBarberIdentityDbError,
  logBookingInsertSuccess,
  logDbInsertDebug,
  assertNotUuidForBigintBarberId,
};
