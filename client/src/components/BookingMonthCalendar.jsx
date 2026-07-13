import { useEffect, useMemo, useState } from "react";
import { fetchBookingCalendar } from "../services/bookingCalendarApi.js";

const WEEK_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function cellClass(status, selected) {
  if (selected) return "ifcdc-cal__cell ifcdc-cal__cell--selected";
  switch (status) {
    case "available":
      return "ifcdc-cal__cell ifcdc-cal__cell--available";
    case "fully_booked":
      return "ifcdc-cal__cell ifcdc-cal__cell--booked";
    case "day_off":
    case "closed":
      return "ifcdc-cal__cell ifcdc-cal__cell--off";
    case "vacation":
    case "blocked":
      return "ifcdc-cal__cell ifcdc-cal__cell--vacation";
    default:
      return "ifcdc-cal__cell ifcdc-cal__cell--disabled";
  }
}

export default function BookingMonthCalendar({
  barberId,
  barberName,
  value,
  durationMinutes = 30,
  onSelectDate,
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [daysByDate, setDaysByDate] = useState({});
  const [meta, setMeta] = useState({ bookingWindowDays: 90 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!barberId && !barberName) return;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchBookingCalendar({ barberId, barberName, year, month, durationMinutes });
        if (cancelled) return;
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        setDaysByDate(map);
        setMeta({ bookingWindowDays: data.bookingWindowDays });
      } catch (e) {
        if (!cancelled) setError(e?.message || "Could not load calendar");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barberId, barberName, year, month, durationMinutes]);

  const cells = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const list = [];
    for (let i = 0; i < startPad; i += 1) list.push(null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      list.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
    return list;
  }, [year, month]);

  const shiftMonth = (delta) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setHint("");
  };

  return (
    <div className="ifcdc-cal">
      <style>{`
        .ifcdc-cal { margin-bottom: 12px; }
        .ifcdc-cal__nav { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
        .ifcdc-cal__nav button, .ifcdc-cal__today {
          background:transparent; border:1px solid rgba(212,175,55,.45); color:#FFD700;
          border-radius:999px; padding:6px 12px; cursor:pointer; font-weight:700;
        }
        .ifcdc-cal__title { color:#fafafa; font-weight:800; font-size:1.05rem; }
        .ifcdc-cal__week, .ifcdc-cal__grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
        .ifcdc-cal__week span { text-align:center; color:#a1a1aa; font-size:11px; font-weight:700; }
        .ifcdc-cal__cell {
          aspect-ratio:1; border-radius:10px; border:1px solid transparent; background:rgba(255,255,255,.03);
          color:#e4e4e7; font-weight:700; cursor:pointer;
        }
        .ifcdc-cal__cell--available { background:rgba(245,200,66,.12); border-color:rgba(245,200,66,.35); }
        .ifcdc-cal__cell--selected { background:#FFD700; color:#111; border-color:#FFD700; }
        .ifcdc-cal__cell--booked { background:rgba(248,113,113,.12); color:#fca5a5; cursor:not-allowed; }
        .ifcdc-cal__cell--off { background:rgba(148,163,184,.12); color:#94a3b8; cursor:not-allowed; }
        .ifcdc-cal__cell--vacation { background:rgba(96,165,250,.12); color:#93c5fd; cursor:not-allowed; }
        .ifcdc-cal__cell--disabled { opacity:.35; cursor:not-allowed; }
        .ifcdc-cal__hint {
          margin-top:10px; padding:10px; border-radius:8px; border:1px solid rgba(245,200,66,.35);
          background:rgba(245,200,66,.08); color:#fafafa; font-size:13px;
        }
        .ifcdc-cal__legend { margin-top:8px; color:#a1a1aa; font-size:12px; }
      `}</style>
      <div className="ifcdc-cal__nav">
        <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <div className="ifcdc-cal__title">{monthLabel(year, month)}</div>
        <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div style={{ textAlign: "center", marginBottom: 10 }}>
        <button
          type="button"
          className="ifcdc-cal__today"
          onClick={() => {
            const n = new Date();
            setYear(n.getFullYear());
            setMonth(n.getMonth() + 1);
          }}
        >
          Today
        </button>
      </div>
      <div className="ifcdc-cal__week">
        {WEEK_HEADERS.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {loading ? <p className="ifcdc-page-hint">Loading calendar…</p> : null}
      {error ? <p className="ifcdc-error-msg">{error}</p> : null}
      <div className="ifcdc-cal__grid">
        {cells.map((ymd, idx) => {
          if (!ymd) return <div key={`pad-${idx}`} />;
          const info = daysByDate[ymd] || { status: "outside_window", selectable: false };
          const selected = value === ymd;
          return (
            <button
              key={ymd}
              type="button"
              className={cellClass(info.status, selected)}
              disabled={!info.selectable}
              title={info.message || (info.selectable ? "Available" : "Unavailable")}
              onClick={() => {
                if (!info.selectable) {
                  setHint(info.message || "This date is unavailable.");
                  return;
                }
                setHint("");
                onSelectDate?.(ymd, info);
              }}
            >
              {Number(ymd.slice(8, 10))}
            </button>
          );
        })}
      </div>
      {hint ? <div className="ifcdc-cal__hint">{hint}</div> : null}
      <p className="ifcdc-cal__legend">
        Book up to {meta.bookingWindowDays || 90} days ahead · Gold = available · Dim = unavailable
      </p>
    </div>
  );
}
