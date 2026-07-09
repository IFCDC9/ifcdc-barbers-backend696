import { Link, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { fetchProviderAppointments } from "../services/providerAppointmentsApi.js";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDate(ymd, delta) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export default function ProviderSchedulePage() {
  const navigate = useNavigate();
  const user = readUser();
  const barberId = user?.barberId ?? user?.barber_id;
  const [date, setDate] = useState(todayYmd());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!barberId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProviderAppointments(barberId, date);
      setRows(Array.isArray(data.appointments) ? data.appointments : []);
      if (data.date) setDate(data.date);
    } catch (e) {
      setError(e?.message || "Could not load schedule");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [barberId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const role = String(user?.role || "");
  const canView = role === "barber" || role === "shop_owner" || role === "admin" || role === "super_admin";

  if (!user || !canView || !barberId) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">My schedule</h1>
        <p className="ifcdc-page-lead">Provider sign-in required.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          Sign in
        </Link>
      </div>
    );
  }

  const isToday = date === todayYmd();

  return (
    <div className="ifcdc-profile">
      <button type="button" className="ifcdc-book-wizard__back" onClick={() => navigate("/profile")}>
        ← Profile
      </button>
      <h1 className="ifcdc-page-title">{isToday ? "Today's bookings" : "My schedule"}</h1>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button type="button" className="ifcdc-book-wizard__back" onClick={() => setDate((d) => shiftDate(d, -1))}>
          ◀
        </button>
        <span style={{ flex: 1, textAlign: "center", fontWeight: 700 }}>{isToday ? `Today · ${date}` : date}</span>
        <button type="button" className="ifcdc-book-wizard__back" onClick={() => setDate((d) => shiftDate(d, 1))}>
          ▶
        </button>
      </div>
      {!isToday ? (
        <button type="button" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={() => setDate(todayYmd())}>
          Jump to today
        </button>
      ) : null}
      {loading ? <p className="ifcdc-page-hint">Loading…</p> : null}
      {error ? <p className="ifcdc-error-msg">{error}</p> : null}
      {!loading && !rows.length && !error ? <p className="ifcdc-page-hint">No appointments this day.</p> : null}
      <ul className="ifcdc-book-wizard__list">
        {rows.map((row) => (
          <li key={row.id} className="ifcdc-book-wizard__summary">
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              {row.styleImageUrl ? (
                <img
                  src={row.styleImageUrl}
                  alt=""
                  style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover" }}
                />
              ) : null}
              <div>
                <strong>{row.customerName || "Client"}</strong>
                <br />
                {row.service} · {row.time}
                <br />
                Payment: {row.paymentStatus || "—"} · Status: {row.bookingStatus || "—"}
                <br />
                ${Number(row.totalAmount || 0).toFixed(2)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
