import { dbQuery } from "./db.js";
import { getAvailableSlotsForBarberDate } from "./barberSlotEngine.js";

function stripQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function ymd(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function resolveDateLabelToYmd(label) {
  const t = stripQuotes(label);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const low = t.toLowerCase();
  if (low === "today") return ymd(base);
  if (low === "tomorrow") {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return ymd(d);
  }
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const want = days.indexOf(low);
  if (want < 0) return null;
  const cur = base.getDay();
  const add = (want - cur + 7) % 7;
  const d = new Date(base);
  d.setDate(d.getDate() + add);
  return ymd(d);
}

/** Public GET /api/barber/available-slots */
export async function handleBarberAvailableSlotsGet(req, res) {
  try {
    const barberIdRaw = stripQuotes(req.query.barberId);
    const barberName = stripQuotes(req.query.barberName);
    const dateRaw = stripQuotes(req.query.date);
    const dateLabel = stripQuotes(req.query.dateLabel);

    let dateStr = null;
    if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) dateStr = dateRaw;
    else if (dateLabel) dateStr = resolveDateLabelToYmd(dateLabel);

    if (!dateStr) {
      return res.status(400).json({ ok: false, error: "bad_date", message: "Pass date=YYYY-MM-DD or dateLabel=Today" });
    }
    if (!barberIdRaw && !barberName) {
      return res.status(400).json({ ok: false, error: "query_required", message: "barberId or barberName required" });
    }

    let barberId = barberIdRaw || null;
    let name = barberName;

    if (barberIdRaw) {
      const r = await dbQuery(`SELECT id, name FROM barbers WHERE id::text = $1 LIMIT 1`, [barberIdRaw]);
      if (r.rows?.[0]) {
        barberId = r.rows[0].id;
        name = String(r.rows[0].name || barberName || "");
      }
    } else if (barberName) {
      const r = await dbQuery(
        `SELECT id, name FROM barbers WHERE lower(trim(name)) = lower(trim($1)) ORDER BY id ASC LIMIT 1`,
        [barberName],
      );
      if (r.rows?.[0]) {
        barberId = r.rows[0].id;
        name = String(r.rows[0].name || barberName);
      }
    }

    if (barberId == null) {
      return res.json({ ok: true, date: dateStr, slots: [], timezone: null, intervalMinutes: 30 });
    }

    const payload = await getAvailableSlotsForBarberDate(barberId, dateStr, name);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    return res.json({ ok: true, date: dateStr, barberId, ...payload });
  } catch (e) {
    console.error("[barber] available-slots:", e?.stack || e);
    return res.status(500).json({ ok: false, error: "server_error", message: e instanceof Error ? e.message : String(e) });
  }
}
