/**
 * Public booking handlers — no auth. Used by server.js early mounts and app-bookings router.
 */
const { fetchPublicBarberServices, stripQuotes } = require("./bookingServicesCatalog.cjs");
const { bookableBarberWhereSql } = require("./barberBookingPolicy.cjs");

async function resolveBarberRowByName(dbQuery, barberName) {
  const br = await dbQuery(
    `SELECT id, name, business_id FROM barbers WHERE lower(trim(name)) = lower(trim($1)) ORDER BY id ASC LIMIT 1`,
    [barberName],
  );
  return br.rows?.[0] || null;
}

function parseServicesQuery(req) {
  const q = req.query || {};
  return {
    barberIdRaw: stripQuotes(q.barberId ?? q.barber_id ?? ""),
    barberName: stripQuotes(q.barberName ?? q.barber_name ?? ""),
  };
}

/**
 * GET /api/barber/services — public bookable menu (seeds DB defaults).
 */
async function handlePublicBarberServicesGet(req, res, dbQuery) {
  const { barberIdRaw, barberName } = parseServicesQuery(req);
  if (!barberIdRaw && !barberName) {
    return res.status(400).json({
      error: "query_required",
      message: "Pass barberId, barber_id, or barberName.",
    });
  }

  const result = await fetchPublicBarberServices(dbQuery, { barberIdRaw, barberName });
  if (result.error === "barber_not_found") {
    return res.status(404).json({ error: "not_found", message: "Barber not found" });
  }

  res.set("Cache-Control", "no-store");
  return res.json({
    ok: true,
    services: result.services,
    barberId: result.barberId,
    fallbackUsed: result.fallbackUsed,
  });
}

function resolvePublicBookingChannel(req) {
  const raw = stripQuotes(req.query?.channel ?? req.query?.bookingChannel ?? "");
  const ch = String(raw || "").trim().toLowerCase();
  if (ch === "website" || ch === "web") return "website";
  if (ch === "mobile" || ch === "app") return "mobile";
  const origin = String(req.get?.("origin") || req.get?.("referer") || "").toLowerCase();
  if (origin.includes("ifcdcbarbersapp.com") || origin.includes("ifcdc-barbers-frontend")) {
    return "website";
  }
  return "mobile";
}

/**
 * GET /api/app-bookings/barbers — bookable barber list for mobile/website pickers (Postgres only).
 */
async function handlePublicBarbersListGet(req, res, dbQuery) {
  const providerTypeRaw = stripQuotes(req.query?.providerType ?? req.query?.provider_type ?? "");
  let providerType = providerTypeRaw ? String(providerTypeRaw).trim().toLowerCase() : "";
  if (!providerType || providerType === "all" || providerType === "*") providerType = "";
  const channel = resolvePublicBookingChannel(req);
  let rows = [];
  try {
    const r = await dbQuery(
      `
      SELECT
        b.id,
        COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), '')) AS name,
        COALESCE(NULLIF(trim(p.profile_image_url), ''), NULLIF(trim(b.profile_image), '')) AS photo,
        COALESCE(b.provider_type, 'barber') AS provider_type
      FROM barbers b
      LEFT JOIN LATERAL (
        SELECT bp.name, bp.profile_image_url
        FROM barber_profiles bp
        WHERE bp.id::text = b.id::text
           OR (b.name IS NOT NULL AND lower(trim(bp.name)) = lower(trim(b.name)))
        ORDER BY CASE WHEN bp.id::text = b.id::text THEN 0 ELSE 1 END
        LIMIT 1
      ) p ON true
      WHERE COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), '')) IS NOT NULL
        AND ${bookableBarberWhereSql({ channel })}
        ${providerType ? "AND lower(coalesce(b.provider_type, 'barber')) = lower($1)" : ""}
      ORDER BY lower(COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), ''))) ASC
      LIMIT 500
      `,
      providerType ? [providerType] : [],
    );
    rows = r.rows || [];
  } catch {
    const r = await dbQuery(
      `SELECT b.id, b.name, b.profile_image AS photo
       FROM barbers b
       WHERE b.name IS NOT NULL AND trim(b.name) <> ''
         AND ${bookableBarberWhereSql({ channel })}
       ORDER BY lower(trim(b.name)) ASC
       LIMIT 500`,
    );
    rows = r.rows || [];
  }

  const barbers = rows.map((row) => ({
    id: row.id,
    name: row.name,
    photo: row.photo || "",
    image: row.photo || "",
    providerType: row.provider_type || "barber",
    active: true,
  }));

  res.set("Cache-Control", "no-store");
  return res.json(barbers);
}

module.exports = {
  handlePublicBarberServicesGet,
  handlePublicBarbersListGet,
  parseServicesQuery,
};
