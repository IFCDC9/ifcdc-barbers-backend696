/** Default bookable services — seeded when a barber has none yet. */
const DEFAULT_BOOKING_SERVICES = [
  {
    name: "Regular Haircut",
    description: "Classic cut and style",
    price: 25,
    duration_minutes: 30,
    icon: "✂️",
  },
  {
    name: "Fade",
    description: "Clean fade with crisp lines",
    price: 30,
    duration_minutes: 30,
    icon: "💈",
  },
  {
    name: "Beard Trim",
    description: "Shape and trim beard",
    price: 15,
    duration_minutes: 15,
    icon: "🧔",
  },
  {
    name: "Kids Cut",
    description: "Haircut for children 12 and under",
    price: 20,
    duration_minutes: 30,
    icon: "👦",
  },
  {
    name: "Line Up",
    description: "Edge-up and line refinement",
    price: 12,
    duration_minutes: 15,
    icon: "📐",
  },
  {
    name: "Haircut + Beard",
    description: "Full haircut with beard trim",
    price: 40,
    duration_minutes: 45,
    icon: "⭐",
  },
];

/** Catalog barbers used by mobile booking when not yet in Postgres. */
const {
  BOOKING_BARBER_CATALOG,
  stripQuotes,
  isUuidBarberId,
  numericCatalogBarberId,
  ensureBarberRowForServices,
  lookupBarberRow,
  resolveBarberIdentity,
  resolveBarberForBooking,
  scheduleBarberIdFromResolved,
  coerceBarberIdForTable,
  barberIdForTable,
  logDbInsertDebug,
  assertNotUuidForBigintBarberId,
  resolvedBarberDbIdOnly,
  getTableBarberIdType,
} = require("./barberIdentity.cjs");
const { normalizePublishedImageUrl } = require("./styleImageUrl.cjs");

function mapServiceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    barber_id: row.barber_id,
    business_id: row.business_id,
    name: row.name,
    description: row.description || "",
    category: row.category || "",
    price: Number(row.price),
    duration_minutes: Number(row.duration_minutes) || 30,
    icon: row.icon || "",
    image_url: normalizePublishedImageUrl(row.image_url, {
      serviceId: row.id,
      barberId: row.barber_id,
    }),
    is_active: row.is_active !== false,
  };
}

/** Map fallback catalog id (local-*) to default service name. */
function fallbackServiceNameFromId(serviceId) {
  const id = String(serviceId || "").trim().toLowerCase();
  const hit = DEFAULT_BOOKING_SERVICES.find((s) => {
    const slug = `local-${String(s.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    return id === slug;
  });
  return hit?.name || null;
}

async function resolveBarberForServices(dbQuery, { barberIdRaw, barberName }) {
  return lookupBarberRow(dbQuery, {
    idRaw: barberIdRaw != null ? String(barberIdRaw).trim() : "",
    nameRaw: barberName != null ? String(barberName).trim() : "",
  });
}

/** Never return UUID for BIGINT barber_services.barber_id columns. */
async function serviceBarberKey(dbQuery, barberRow, barberName) {
  const resolved = await resolveBarberIdentity(dbQuery, barberRow, barberName);
  return resolved?.serviceBarberKey ?? null;
}

/**
 * Load active services for a barber; seed defaults when catalog is empty.
 * @returns {Promise<{ services: object[], seeded: boolean }>}
 */
async function ensureBarberServices(dbQuery, barberId, barberName = "") {
  let serviceKey = barberId;
  if (isUuidBarberId(serviceKey)) {
    serviceKey = await coerceBarberIdForTable(dbQuery, "barber_services", serviceKey, barberName);
  } else if (serviceKey != null && typeof serviceKey === "object" && serviceKey.serviceBarberKey != null) {
    serviceKey = serviceKey.serviceBarberKey;
  }
  if (serviceKey == null || String(serviceKey).trim() === "" || isUuidBarberId(serviceKey)) {
    const resolved = await resolveBarberIdentity(dbQuery, barberId, barberName);
    serviceKey = resolved ? await barberIdForTable(dbQuery, "barber_services", resolved) : null;
  }
  if (serviceKey == null || String(serviceKey).trim() === "") {
    return { services: [], seeded: false };
  }

  const list = await dbQuery(
    `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
            price::float8 AS price, duration_minutes, is_active
     FROM barber_services
     WHERE barber_id::text = $1::text AND is_active = true
     ORDER BY id ASC`,
    [String(serviceKey)],
  );
  if (list.rows?.length) {
    return { services: list.rows.map(mapServiceRow).filter(Boolean), seeded: false };
  }

  for (const s of DEFAULT_BOOKING_SERVICES) {
    const servicesCol = await getTableBarberIdType(dbQuery, "barber_services");
    logDbInsertDebug({
      route: "ensureBarberServices",
      table: "barber_services",
      barber_id: serviceKey,
      resolvedBarberDbId: resolvedBarberDbIdOnly({ barberDbId: typeof serviceKey === "number" ? serviceKey : null }),
      servicesColType: servicesCol,
    });
    if (servicesCol !== "uuid") {
      assertNotUuidForBigintBarberId(serviceKey, "barber_services", "ensureBarberServices");
    }
    await dbQuery(
      `INSERT INTO barber_services (barber_id, name, description, icon, price, duration_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [serviceKey, s.name, s.description, s.icon, s.price, s.duration_minutes],
    );
  }

  const seeded = await dbQuery(
    `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
            price::float8 AS price, duration_minutes, is_active
     FROM barber_services
     WHERE barber_id::text = $1::text AND is_active = true
     ORDER BY id ASC`,
    [String(serviceKey)],
  );
  return { services: (seeded.rows || []).map(mapServiceRow).filter(Boolean), seeded: true };
}

/**
 * Public booking catalog — resolve barber, seed defaults, structured logging.
 */
async function fetchPublicBarberServices(dbQuery, { barberIdRaw, barberName }) {
  let error = null;
  let barberId = null;
  let fallbackUsed = false;
  let services = [];

  try {
    const barberRow = await resolveBarberForServices(dbQuery, { barberIdRaw, barberName });
    if (!barberRow) {
      error = "barber_not_found";
      console.log(`[services] barberId=${barberIdRaw || "—"}, count=0, fallbackUsed=false, error=${error}`);
      return { barberId: null, services: [], fallbackUsed: false, error };
    }
    barberId = barberRow.id;
    const serviceKey = await serviceBarberKey(dbQuery, barberRow, barberName || barberRow.name);
    if (serviceKey == null) {
      error = "barber_not_found";
      console.log(`[services] barberId=${barberIdRaw || "—"}, count=0, fallbackUsed=false, error=${error}`);
      return { barberId: null, services: [], fallbackUsed: false, error };
    }
    const loaded = await ensureBarberServices(dbQuery, serviceKey, barberName || barberRow.name);
    services = loaded.services;
    fallbackUsed = loaded.seeded;
    console.log(
      `[services] barberId=${barberId}, count=${services.length}, fallbackUsed=${fallbackUsed}, error=null`,
    );
    return { barberId, services, fallbackUsed, error: null };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.log(`[services] barberId=${barberIdRaw || "—"}, count=0, fallbackUsed=false, error=${error}`);
    throw e;
  }
}

/** Resolve by exact service name after catalog is seeded. */
async function resolveServiceByName(dbQuery, barberServiceKey, serviceName) {
  const name = String(serviceName || "").trim();
  if (!name || barberServiceKey == null || String(barberServiceKey).trim() === "") return null;
  const r = await dbQuery(
    `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
            price::float8 AS price, duration_minutes, is_active
     FROM barber_services
     WHERE barber_id::text = $1::text AND lower(name) = lower($2) AND is_active = true
     LIMIT 1`,
    [String(barberServiceKey), name],
  );
  return mapServiceRow(r.rows?.[0]);
}

/** Resolve a selected service for checkout (server-side price authority). */
async function resolveServiceForBooking(dbQuery, barberServiceKey, serviceId, serviceName, barberName = "") {
  if (barberServiceKey == null || String(barberServiceKey).trim() === "") return null;
  const sk = String(barberServiceKey);

  const sid = Number(serviceId);
  if (Number.isFinite(sid) && sid > 0) {
    const r = await dbQuery(
      `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
              price::float8 AS price, duration_minutes, is_active
       FROM barber_services
       WHERE id = $1 AND barber_id::text = $2::text AND is_active = true
       LIMIT 1`,
      [sid, sk],
    );
    const hit = mapServiceRow(r.rows?.[0]);
    if (hit) return hit;
  }

  const fallbackName =
    String(serviceName || "").trim() || fallbackServiceNameFromId(serviceId) || "";
  if (!fallbackName) return null;

  await ensureBarberServices(dbQuery, barberServiceKey, barberName);
  return resolveServiceByName(dbQuery, barberServiceKey, fallbackName);
}

module.exports = {
  DEFAULT_BOOKING_SERVICES,
  BOOKING_BARBER_CATALOG,
  stripQuotes,
  isUuidBarberId,
  isUuidString: isUuidBarberId,
  numericCatalogBarberId,
  resolveBarberForServices,
  resolveBarberForBooking,
  resolveBarberIdentity,
  scheduleBarberIdFromResolved,
  ensureBarberRowForServices,
  serviceBarberKey,
  ensureBarberServices,
  fetchPublicBarberServices,
  resolveServiceByName,
  resolveServiceForBooking,
  fallbackServiceNameFromId,
  coerceBarberIdForTable,
  barberIdForTable,
};
