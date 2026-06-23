import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { fetchAdminShops } from "../services/api.js";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.colors.border}`,
  backgroundColor: "rgba(0,0,0,0.25)",
  color: theme.colors.text,
  fontSize: 14,
};

function pillStyle(tone) {
  const colors =
    tone === "green"
      ? { bg: "rgba(34,197,94,0.18)", fg: "#86efac" }
      : tone === "red"
        ? { bg: "rgba(248,113,113,0.18)", fg: "#fca5a5" }
        : tone === "gold"
          ? { bg: "rgba(245,200,66,0.18)", fg: "#f5c842" }
          : { bg: "rgba(148,163,184,0.15)", fg: theme.colors.muted };
  return {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 800,
    background: colors.bg,
    color: colors.fg,
    marginRight: 6,
  };
}

export default function AdminShops() {
  const user = getStoredUser();
  const token = getStoredToken();
  const isSuper = user?.role === "super_admin" || user?.role === "admin";

  const [shop, setShop] = React.useState("");
  const [city, setCity] = React.useState("");
  const [state, setState] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [sort, setSort] = React.useState("newest");
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await fetchAdminShops({
        shop: shop.trim() || undefined,
        city: city.trim() || undefined,
        state: state.trim() || undefined,
        status: status || undefined,
        sort: sort === "newest" ? undefined : sort,
      });
      setRows(Array.isArray(j?.shops) ? j.shops : []);
    } catch (e) {
      setError(e?.message || "Failed to load shops");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [shop, city, state, status, sort]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin" && user.role !== "shop_owner")) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Page>
      <PageHeader
        title="Shops / Locations Management"
        subtitle={isSuper ? "Global platform view — every shop and location" : "Your shop"}
        right={
          <Link to="/admin" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← Admin
          </Link>
        }
      />

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Filters</CardTitle>
        <div style={{ display: "grid", gap: 10, marginTop: 12, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <input style={inputStyle} placeholder="Shop name" value={shop} onChange={(e) => setShop(e.target.value)} />
          <input style={inputStyle} placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <input style={inputStyle} placeholder="State" value={state} onChange={(e) => setState(e.target.value)} />
          <select style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </select>
          <select style={inputStyle} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="revenue">Revenue</option>
          </select>
        </div>
        <Button variant="indigo" type="button" onClick={() => void load()} style={{ marginTop: 12 }}>
          Apply filters
        </Button>
      </Card>

      {loading ? <p style={{ marginTop: 16, color: theme.colors.muted }}>Loading shops…</p> : null}
      {error ? <p style={{ marginTop: 16, color: "#f87171" }}>{error}</p> : null}
      {!loading && !error && !rows.length ? (
        <p style={{ marginTop: 16, color: theme.colors.muted }}>No shops match these filters.</p>
      ) : null}

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {rows.map((row) => (
          <Card key={row.id}>
            <CardTitle>{row.shopName}</CardTitle>
            <p style={{ margin: "8px 0 0", color: theme.colors.muted, fontSize: 14 }}>
              <strong>Owner:</strong> {row.ownerName}
              <br />
              <strong>Email:</strong> {row.ownerEmail}
              {row.ownerPhone ? (
                <>
                  <br />
                  <strong>Phone:</strong> {row.ownerPhone}
                </>
              ) : null}
              <br />
              <strong>Location:</strong> {row.locationLabel}
              <br />
              <strong>Address:</strong> {row.address}
              <br />
              <strong>Registered:</strong>{" "}
              {row.registrationDate ? new Date(row.registrationDate).toLocaleDateString() : "—"}
              <br />
              <strong>Barbers:</strong> {row.barberCount} · <strong>Bookings:</strong> {row.bookingCount}
              <br />
              <strong>Revenue:</strong> ${Number(row.totalRevenue || 0).toFixed(2)} ·{" "}
              <strong>Platform fees:</strong> ${Number(row.platformFees || 0).toFixed(2)}
            </p>
            <div style={{ marginTop: 10 }}>
              <span style={pillStyle(row.accountStatus === "Active" ? "green" : row.accountStatus === "Pending" ? "gold" : "red")}>
                {row.accountStatus}
              </span>
              <span style={pillStyle("green")}>{row.subscriptionStatus}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
              <Link to={`/admin/shops/${row.businessId}`}>
                <Button variant="indigo" type="button">
                  View shop
                </Button>
              </Link>
              <Link to={`/admin/shops/${row.businessId}?edit=1`}>
                <Button variant="ghost" type="button">
                  Edit
                </Button>
              </Link>
              <Link to={`/admin/barbers?shop=${encodeURIComponent(row.shopName)}`}>
                <Button variant="ghost" type="button">
                  Barbers
                </Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
