import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { apiGet, apiUrl, fetchWithTimeout } from "../lib/api.js";
import { getAdminAuthHeaders, getStoredToken, getStoredUser } from "../lib/authHeaders.js";

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

export default function AdminGlobalBarbers() {
  const user = getStoredUser();
  const token = getStoredToken();

  const [shop, setShop] = React.useState("");
  const [city, setCity] = React.useState("");
  const [state, setState] = React.useState("");
  const [active, setActive] = React.useState("");
  const [pendingOnly, setPendingOnly] = React.useState(false);
  const [sort, setSort] = React.useState("newest");
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams();
      if (shop.trim()) q.set("shop", shop.trim());
      if (city.trim()) q.set("city", city.trim());
      if (state.trim()) q.set("state", state.trim());
      if (active) q.set("active", active);
      if (pendingOnly) q.set("pendingApproval", "true");
      if (sort === "oldest") q.set("sort", "asc");
      else if (sort === "name") q.set("sort", "name");
      else if (sort === "shop") q.set("sort", "shop");
      const suffix = q.toString() ? `?${q.toString()}` : "";
      const j = await apiGet(`/api/admin/barbers${suffix}`, { headers: getAdminAuthHeaders() });
      setRows(Array.isArray(j?.barbers) ? j.barbers : []);
    } catch (e) {
      setError(e?.message || "Failed to load barbers");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [shop, city, state, active, pendingOnly, sort]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = async (barberId, path, body) => {
    const res = await fetchWithTimeout(apiUrl(`/api/admin/barbers/${barberId}/${path}`), {
      method: "PATCH",
      headers: { ...getAdminAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.message || `Update failed (${res.status})`);
  };

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin" && user.role !== "shop_owner")) {
    return <Navigate to="/login" replace />;
  }

  const isSuper = user.role === "super_admin" || user.role === "admin";

  return (
    <Page>
      <PageHeader
        title="Barber management"
        subtitle={isSuper ? "Global platform view — all registered barbers" : "Barbers at your shop"}
        right={
          <Link to="/admin" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← Admin
          </Link>
        }
      />

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Filters</CardTitle>
        <div style={{ display: "grid", gap: 10, marginTop: 12, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <input style={inputStyle} placeholder="Shop" value={shop} onChange={(e) => setShop(e.target.value)} />
          <input style={inputStyle} placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <input style={inputStyle} placeholder="State" value={state} onChange={(e) => setState(e.target.value)} />
          <select style={inputStyle} value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="">All activity</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive / pending</option>
          </select>
          <select style={inputStyle} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="shop">Shop A–Z</option>
          </select>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, color: theme.colors.muted, fontSize: 13 }}>
          <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
          Pending approval only
        </label>
        <Button variant="indigo" type="button" onClick={() => void load()} style={{ marginTop: 12 }}>
          Apply filters
        </Button>
      </Card>

      {loading ? <p style={{ marginTop: 16, color: theme.colors.muted }}>Loading…</p> : null}
      {error ? <p style={{ marginTop: 16, color: "#f87171" }}>{error}</p> : null}
      {!loading && !error && !rows.length ? (
        <p style={{ marginTop: 16, color: theme.colors.muted }}>No barbers match these filters.</p>
      ) : null}

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {rows.map((row) => (
          <Card key={row.id}>
            <CardTitle>{row.fullName}</CardTitle>
            <p style={{ margin: "8px 0 0", color: theme.colors.muted, fontSize: 14 }}>
              <strong>Shop:</strong> {row.shopName}
              <br />
              <strong>Location:</strong> {row.locationLabel}
              <br />
              <strong>Email:</strong> {row.email}
              {row.phone ? (
                <>
                  <br />
                  <strong>Phone:</strong> {row.phone}
                </>
              ) : null}
              <br />
              <strong>Registered:</strong>{" "}
              {row.registrationDate ? new Date(row.registrationDate).toLocaleDateString() : "—"}
            </p>
            <div style={{ marginTop: 10 }}>
              <span style={pillStyle("gold")}>{row.accountStatus}</span>
              <span style={pillStyle("green")}>{row.subscriptionStatus}</span>
              <span style={pillStyle(row.verificationStatus === "Pending" ? "gold" : "green")}>{row.verificationStatus}</span>
            </div>
            {isSuper && row.pendingApproval ? (
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <Button
                  variant="indigo"
                  type="button"
                  onClick={async () => {
                    await patch(row.barberId, "verification", { status: "approved" });
                    await patch(row.barberId, "account-status", { status: "approved" });
                    await load();
                  }}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={async () => {
                    await patch(row.barberId, "account-status", { status: "suspended" });
                    await load();
                  }}
                >
                  Suspend
                </Button>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </Page>
  );
}
