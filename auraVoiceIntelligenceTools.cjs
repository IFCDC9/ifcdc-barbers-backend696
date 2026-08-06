/**
 * Live DB tools for AURA Voice Intelligence — never invent shop facts.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");

function safeRows(r) {
  return Array.isArray(r?.rows) ? r.rows : [];
}

async function listActiveBarbers(dbQuery, { limit = 8 } = {}) {
  try {
    const r = await dbQuery(
      `SELECT id, name, status
       FROM barbers
       WHERE coalesce(lower(status),'active') IN ('active','approved','')
          OR status IS NULL
       ORDER BY name ASC NULLS LAST
       LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 8, 1), 20)],
    );
    return safeRows(r);
  } catch (e) {
    console.warn("[aura-voice-intel] listActiveBarbers:", e?.message || e);
    return null;
  }
}

async function listPublicServices(dbQuery, { limit = 10 } = {}) {
  try {
    const r = await dbQuery(
      `SELECT id, title, price, duration_minutes
       FROM styles
       WHERE coalesce(hidden,false) = false
       ORDER BY title ASC NULLS LAST
       LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 10, 1), 25)],
    );
    return safeRows(r);
  } catch (e) {
    try {
      const r2 = await dbQuery(
        `SELECT id, name AS title, price, duration_minutes
         FROM services
         ORDER BY name ASC NULLS LAST
         LIMIT $1`,
        [Math.min(Math.max(Number(limit) || 10, 1), 25)],
      );
      return safeRows(r2);
    } catch (e2) {
      console.warn("[aura-voice-intel] listPublicServices:", e?.message || e, e2?.message || e2);
      return null;
    }
  }
}

async function resolveShopContact(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT name, phone, address, city, state
       FROM businesses
       WHERE id = 1 OR name ILIKE '%IFCDC%'
       ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, id ASC
       LIMIT 1`,
    );
    return safeRows(r)[0] || null;
  } catch (e) {
    console.warn("[aura-voice-intel] resolveShopContact:", e?.message || e);
    return null;
  }
}

async function findBookingsByPhone(dbQuery, phoneRaw, { limit = 5 } = {}) {
  const n = normalizeToE164(phoneRaw);
  if (!n.ok) return [];
  const digits = n.e164.replace(/\D/g, "").slice(-10);
  try {
    const r = await dbQuery(
      `SELECT id, customer_name, phone, service, barber_name, date, time,
              booking_status, payment_status, created_at
       FROM bookings
       WHERE deleted_at IS NULL
         AND (
           regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE '%' || $1
           OR regexp_replace(coalesce(customer_phone,''), '\\D', '', 'g') LIKE '%' || $1
         )
       ORDER BY created_at DESC NULLS LAST
       LIMIT $2`,
      [digits, Math.min(Math.max(Number(limit) || 5, 1), 10)],
    );
    return safeRows(r);
  } catch (e) {
    console.warn("[aura-voice-intel] findBookingsByPhone:", e?.message || e);
    return null;
  }
}

async function ownerTodaySummary(dbQuery) {
  try {
    const r = await dbQuery(
      `SELECT
         COUNT(*) FILTER (WHERE date::date = CURRENT_DATE)::int AS bookings_today,
         COUNT(*) FILTER (
           WHERE date::date = CURRENT_DATE
             AND lower(coalesce(booking_status,'')) IN ('canceled','cancelled')
         )::int AS canceled_today,
         COUNT(*) FILTER (
           WHERE created_at::date = CURRENT_DATE
         )::int AS created_today,
         COUNT(*) FILTER (
           WHERE date::date = CURRENT_DATE
             AND lower(coalesce(payment_status,'')) IN ('paid','paid_in_full','captured')
         )::int AS paid_today
       FROM bookings
       WHERE deleted_at IS NULL`,
    );
    return safeRows(r)[0] || null;
  } catch (e) {
    console.warn("[aura-voice-intel] ownerTodaySummary:", e?.message || e);
    return null;
  }
}

async function ownerNewCustomerCount(dbQuery, { days = 7 } = {}) {
  try {
    const r = await dbQuery(
      `SELECT COUNT(DISTINCT lower(coalesce(customer_email, email, phone)))::int AS n
       FROM bookings
       WHERE deleted_at IS NULL
         AND created_at > NOW() - ($1::text || ' days')::interval`,
      [String(Math.min(Math.max(Number(days) || 7, 1), 30))],
    );
    return Number(safeRows(r)[0]?.n || 0);
  } catch (e) {
    console.warn("[aura-voice-intel] ownerNewCustomerCount:", e?.message || e);
    return null;
  }
}

function speakUnavailable(topic) {
  return `I cannot confirm ${topic} from live records right now. I can try another question, or connect you with the team for help.`;
}

function formatServiceList(rows) {
  if (!rows || !rows.length) return null;
  const parts = rows.slice(0, 6).map((s) => {
    const title = String(s.title || "service").trim();
    const price = s.price != null && String(s.price).trim() ? ` at ${s.price} dollars` : "";
    const dur =
      s.duration_minutes != null && Number(s.duration_minutes) > 0
        ? `, about ${Number(s.duration_minutes)} minutes`
        : "";
    return `${title}${price}${dur}`;
  });
  return `Here is what I can confirm from our live menu: ${parts.join("; ")}.`;
}

function formatBarberList(rows) {
  if (!rows || !rows.length) return null;
  const names = rows
    .slice(0, 6)
    .map((b) => String(b.name || "").trim())
    .filter(Boolean);
  if (!names.length) return null;
  return `Our active barbers on record are ${names.join(", ")}. Would you like a specific barber or the first available?`;
}

module.exports = {
  listActiveBarbers,
  listPublicServices,
  resolveShopContact,
  findBookingsByPhone,
  ownerTodaySummary,
  ownerNewCustomerCount,
  speakUnavailable,
  formatServiceList,
  formatBarberList,
};
