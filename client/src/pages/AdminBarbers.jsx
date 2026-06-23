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

export default function AdminBarbers() {
  const [barbers, setBarbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiGet("/api/barbers", { headers: getAdminAuthHeaders() });
        const rows = Array.isArray(data?.barbers) ? data.barbers : Array.isArray(data) ? data : [];
        if (!cancelled) setBarbers(rows);
      } catch (e) {
        console.error("BARBERS ERROR:", e);
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load barbers");
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
      <h2 style={h2}>Barbers</h2>

      {loading ? <p style={{ color: "#a1a1aa" }}>Loading…</p> : null}
      {error ? (
        <p style={{ color: "#fecaca" }} role="alert">
          {error}
        </p>
      ) : null}

      {!loading && !error && barbers.length === 0 ? <p style={{ color: "#a1a1aa" }}>No barbers found.</p> : null}

      {!loading && !error && barbers.length > 0
        ? barbers.map((b, i) => {
            const id = b.id != null ? String(b.id) : `barber-${i}`;
            const shop = b.shop_name && String(b.shop_name).trim() ? b.shop_name : "—";
            return (
              <div key={id} style={card} className="card">
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#fafafa" }}>{b.name || "Unnamed"}</strong>
                </p>
                <p style={{ margin: "4px 0", color: "#a1a1aa", fontSize: 14 }}>Shop: {shop}</p>
                <p style={{ margin: "4px 0", color: "#71717a", fontSize: 12 }}>ID: {id}</p>
              </div>
            );
          })
        : null}
    </div>
  );
}
