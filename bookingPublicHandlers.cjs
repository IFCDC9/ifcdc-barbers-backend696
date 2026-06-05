/**
 * Public booking handlers — no auth. Used by server.js early mounts and app-bookings router.
 */
const { fetchPublicBarberServices, stripQuotes } = require("./bookingServicesCatalog.cjs");

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

/**
 * GET /api/app-bookings/barbers — bookable barber list for mobile picker (Postgres only).
 */
async function handlePublicBarbersListGet(_req, res, dbQuery) {
  let rows = [];
  try {
    const r = await dbQuery(
      `
      SELECT
        b.id,
        COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), '')) AS name,
        COALESCE(NULLIF(trim(p.profile_image_url), ''), NULLIF(trim(b.profile_image), '')) AS photo
      FROM barbers b
      LEFT JOIN barber_profiles p
        ON p.id::text = b.id::text
        OR lower(trim(p.name)) = lower(trim(b.name))
      WHERE COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), '')) IS NOT NULL
      ORDER BY lower(COALESCE(NULLIF(trim(p.name), ''), NULLIF(trim(b.name), ''))) ASC
      LIMIT 500
      `,
    );
    rows = r.rows || [];
  } catch {
    const r = await dbQuery(
      `SELECT id, name, profile_image AS photo
       FROM barbers
       WHERE name IS NOT NULL AND trim(name) <> ''
       ORDER BY lower(trim(name)) ASC
       LIMIT 500`,
    );
    rows = r.rows || [];
  }

  const barbers = rows.map((row) => ({
    id: row.id,
    name: row.name,
    photo: row.photo || "",
    image: row.photo || "",
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
