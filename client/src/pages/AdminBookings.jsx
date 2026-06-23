import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../lib/api.js";
import { getAdminAuthHeaders } from "../lib/authHeaders.js";

const wrap = { maxWidth: "56rem", margin: "0 auto", padding: "1rem 1rem 2rem", color: "#e4e4e7" };
const h2 = { color: "#d4af37", marginBottom: "1rem", fontSize: "1.35rem" };
const card = {
  background: "#111",
  border: "1px solid rgba(212, 175, 55, 0.25)",
  borderRadius: 10,
  padding: "12px 14px",
  marginBottom: 10,
};
const back = { color: "#d4af37", marginBottom: 16, display: "inline-block" };

export default function AdminBookings() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet("/api/bookings", { headers: getAdminAuthHeaders() });
        const rows = Array.isArray(data?.bookings) ? data.bookings : Array.isArray(data) ? data : [];
        if (!cancelled) setBookings(rows);
      } catch (e) {
        console.error("BOOKINGS ERROR:", e);
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load bookings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={wrap}>
      <Link to="/admin" style={back}>
        ← Admin home
      </Link>
      <h2 style={h2}>Shop bookings</h2>

      {loading ? <p style={{ color: "#a1a1aa" }}>Loading…</p> : null}
      {error ? (
        <p style={{ color: "#fecaca" }} role="alert">
          {error}
        </p>
      ) : null}

      {!loading && !error && bookings.length === 0 ? <p style={{ color: "#a1a1aa" }}>No bookings yet.</p> : null}

      {!loading && !error && bookings.length > 0
        ? bookings.map((b, i) => {
            const id = b.id != null ? String(b.id) : `booking-${i}`;
            const name = b.customer_name || b.name || "Guest";
            const service = b.service || "—";
            const date = b.date || "—";
            const time = b.time != null ? String(b.time).slice(0, 5) : "—";
            const status = b.booking_status || b.status || b.payment_status || "";
            return (
              <div key={id} style={card} className="card">
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#fafafa" }}>{name}</strong>
                </p>
                <p style={{ margin: "4px 0", color: "#d4d4d8" }}>{service}</p>
                <p style={{ margin: "4px 0", color: "#a1a1aa", fontSize: 14 }}>
                  {date} @ {time}
                  {status ? (
                    <span style={{ marginLeft: 8, color: "#d4af37" }}>· {String(status)}</span>
                  ) : null}
                </p>
              </div>
            );
          })
        : null}
    </div>
  );
}
