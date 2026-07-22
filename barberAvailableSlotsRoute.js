import { dbQuery } from "./db.js";
import {
  getAvailableSlotsForBarberDate,
  loadBarberSchedule,
  resolveBookingDateLabelToYmd,
} from "./barberSlotEngine.js";

function stripQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Public GET /api/barber/available-slots */
export async function handleBarberAvailableSlotsGet(req, res) {
  try {
    const barberIdRaw = stripQuotes(req.query.barberId);
    const barberName = stripQuotes(req.query.barberName);
    const dateRaw = stripQuotes(req.query.date);
    const dateLabel = stripQuotes(req.query.dateLabel);

    if (!barberIdRaw && !barberName) {
      return res.status(400).json({
        ok: false,
        error: "query_required",
        message: "barberId or barberName required",
      });
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

    let timezone = process.env.SHOP_TIMEZONE || "America/New_York";
    if (barberId != null) {
      try {
        const schedule = await loadBarberSchedule(barberId, name);
        timezone = schedule.timezone || timezone;
      } catch {
        /* keep default */
      }
    }

    let dateStr = null;
    if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) dateStr = dateRaw;
    else if (dateLabel) dateStr = resolveBookingDateLabelToYmd(dateLabel, timezone);

    if (!dateStr) {
      return res.status(400).json({
        ok: false,
        error: "bad_date",
        message: "Pass date=YYYY-MM-DD or dateLabel=Today",
      });
    }

    if (barberId == null) {
      return res.json({ ok: true, date: dateStr, slots: [], timezone: null, intervalMinutes: 30 });
    }

    const durationRaw = stripQuotes(req.query.durationMinutes ?? req.query.duration);
    const durationMinutes = Math.max(1, Number(durationRaw) || 30);
    const payload = await getAvailableSlotsForBarberDate(barberId, dateStr, name, {
      durationMinutes,
    });
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    return res.json({ ok: true, date: dateStr, barberId, durationMinutes, ...payload });
  } catch (e) {
    console.error("[barber] available-slots:", e?.stack || e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
