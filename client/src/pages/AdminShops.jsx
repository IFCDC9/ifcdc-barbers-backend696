import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { approveAdminShop, fetchAdminShopDashboard, fetchAdminShops, rejectAdminShop } from "../services/api.js";
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

function StatCard({ label, value }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: 14, border: `1px solid ${theme.colors.border}` }}>
      <div style={{ fontSize: 12, color: theme.colors.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: theme.colors.text }}>{value}</div>
    </div>
  );
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
  const [dashboard, setDashboard] = React.useState(null);
  const [pendingQueue, setPendingQueue] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listRes, dashRes] = await Promise.all([
        fetchAdminShops({
          shop: shop.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          status: status || undefined,
          sort: sort === "newest" ? undefined : sort,
        }),
        isSuper ? fetchAdminShopDashboard().catch(() => null) : Promise.resolve(null),
      ]);
      setRows(Array.isArray(listRes?.shops) ? listRes.shops : []);
      if (dashRes?.dashboard) {
        setDashboard(dashRes.dashboard);
        setPendingQueue(Array.isArray(dashRes.pendingQueue) ? dashRes.pendingQueue : []);
      }
    } catch (e) {
      setError(e?.message || "Failed to load shops");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [shop, city, state, status, sort, isSuper]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const quickApprove = async (id, plan) => {
    try {
      await approveAdminShop(id, { plan });
      await load();
    } catch (e) {
      setError(e?.message || "Approval failed");
    }
  };

  const quickReject = async (id) => {
    const reason = window.prompt("Rejection reason (optional):") || "";
    try {
      await rejectAdminShop(id, reason);
      await load();
    } catch (e) {
      setError(e?.message || "Rejection failed");
    }
  };

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin" && user.role !== "shop_owner")) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Page>
      <PageHeader
        title="Super Admin Control Center"
        subtitle={isSuper ? "Shops, subscriptions, and platform access" : "Your shop"}
        right={
          <Link to="/admin" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← Admin
          </Link>
        }
      />

      {isSuper && dashboard ? (
        <>
          <div style={{ display: "grid", gap: 12, marginTop: 16, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
            <StatCard label="Total shops" value={dashboard.totalShops} />
            <StatCard label="Pending approval" value={dashboard.pendingApproval} />
            <StatCard label="Active paid" value={dashboard.activePaidShops} />
            <StatCard label="Free shops" value={dashboard.freeShops} />
            <StatCard label="Trial shops" value={dashboard.trialShops} />
            <StatCard label="Suspended" value={dashboard.suspendedShops} />
            <StatCard label="MRR" value={`$${Number(dashboard.mrr || 0).toFixed(2)}`} />
            <StatCard label="Platform fees" value={`$${Number(dashboard.platformFeeRevenue || 0).toFixed(2)}`} />
          </div>

          {pendingQueue.length > 0 ? (
            <Card style={{ marginTop: 16, borderColor: "rgba(245,200,66,0.45)" }}>
              <CardTitle>Pending approval queue</CardTitle>
              <p style={{ color: theme.colors.muted, fontSize: 13, marginTop: 8 }}>
                New shop registrations awaiting your decision. Until approved, shops have limited access (no bookings or payments).
              </p>
              {pendingQueue.map((row) => (
                <div key={row.id} style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${theme.colors.border}` }}>
                  <strong>{row.shopName}</strong>
                  <p style={{ margin: "6px 0", color: theme.colors.muted, fontSize: 14 }}>
                    {row.ownerName} · {row.ownerEmail} · {row.locationLabel}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <Button variant="indigo" type="button" onClick={() => void quickApprove(row.businessId, "free")}>
                      Approve — Free
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => void quickApprove(row.businessId, "trial")}>
                      Approve — Trial
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => void quickApprove(row.businessId, "paid")}>
                      Approve — Paid
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => void quickReject(row.businessId)}>
                      Reject
                    </Button>
                    <Link to={`/admin/shops/${row.businessId}`}>
                      <Button variant="ghost" type="button">
                        Review
                      </Button>
                    </Link>
                  </div>
                </div>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Filters</CardTitle>
        <div style={{ display: "grid", gap: 10, marginTop: 12, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <input style={inputStyle} placeholder="Shop name" value={shop} onChange={(e) => setShop(e.target.value)} />
          <input style={inputStyle} placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <input style={inputStyle} placeholder="State" value={state} onChange={(e) => setState(e.target.value)} />
          <select style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="pending">Pending approval</option>
            <option value="active">Active</option>
            <option value="free">Free plan</option>
            <option value="trial">Trial</option>
            <option value="paid">Paid</option>
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
              <strong>Owner:</strong> {row.ownerName} · {row.ownerEmail}
              <br />
              <strong>Location:</strong> {row.locationLabel} · <strong>Address:</strong> {row.address}
              <br />
              <strong>Plan:</strong> {row.accessPlan} · <strong>Customers:</strong> {row.customerCount} ·{" "}
              <strong>Barbers:</strong> {row.barberCount} · <strong>Bookings:</strong> {row.bookingCount}
              <br />
              <strong>Revenue:</strong> ${Number(row.totalRevenue || 0).toFixed(2)} ·{" "}
              <strong>Platform fees:</strong> ${Number(row.platformFees || 0).toFixed(2)}
            </p>
            <div style={{ marginTop: 10 }}>
              <span style={pillStyle(row.pendingApproval ? "gold" : row.accountStatus === "Active" ? "green" : "red")}>
                {row.pendingApproval ? "Pending approval" : row.accountStatus}
              </span>
              <span style={pillStyle("green")}>{row.accessPlan}</span>
              <span style={pillStyle(row.bookingsEnabled ? "green" : "red")}>
                {row.bookingsEnabled ? "Bookings on" : "Bookings off"}
              </span>
              <span style={pillStyle(row.paymentProcessingEnabled ? "green" : "red")}>
                {row.paymentProcessingEnabled ? "Payments on" : "Payments off"}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
              <Link to={`/admin/shops/${row.businessId}`}>
                <Button variant="indigo" type="button">
                  Manage shop
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
