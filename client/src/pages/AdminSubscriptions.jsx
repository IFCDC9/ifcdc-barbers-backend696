import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getApiOrigin } from "../services/api.js";
import { getAdminAuthHeaders } from "../lib/authHeaders.js";
import { getStoredUser } from "../lib/authHeaders.js";

const page = { background: "#050505", minHeight: "100vh", color: "#e4e4e7", padding: "1.5rem 1rem 4rem" };
const wrap = { maxWidth: 960, margin: "0 auto" };
const gold = "#d4af37";
const card = {
  background: "#111",
  border: "1px solid rgba(212,175,55,0.35)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 14,
};
const table = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th = { textAlign: "left", color: gold, padding: "8px 6px", borderBottom: "1px solid #333" };
const td = { padding: "8px 6px", borderBottom: "1px solid #222", verticalAlign: "top" };

export default function AdminSubscriptions() {
  const user = getStoredUser();
  const isSuper =
    user?.isSuperAdmin === true ||
    user?.isOwner === true ||
    String(user?.role || "").toLowerCase() === "super_admin";
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const origin = getApiOrigin();
      const res = await fetch(`${origin}/api/admin/entitlements/subscriptions`, {
        headers: { ...getAdminAuthHeaders() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e?.message || "Failed to load subscriptions");
    }
  }, []);

  useEffect(() => {
    if (isSuper) void load();
  }, [isSuper, load]);

  if (!isSuper) {
    return (
      <div style={page}>
        <div style={wrap}>
          <h1 style={{ color: gold }}>Subscriptions</h1>
          <p>Only Super Admin can view platform subscriptions. Managers cannot change pricing, credentials, or grant free plans.</p>
          <Link to="/admin" style={{ color: gold }}>
            ← Admin
          </Link>
        </div>
      </div>
    );
  }

  const subs = data?.subscriptions || [];
  const access = data?.appAccess || [];
  const events = data?.recentEvents || [];

  return (
    <div style={page}>
      <div style={wrap}>
        <p style={{ color: gold, letterSpacing: "0.14em", fontSize: 12, fontWeight: 800 }}>SUPER ADMIN</p>
        <h1 style={{ color: gold, marginTop: 6 }}>Subscriptions</h1>
        <p style={{ color: "#a1a1aa" }}>
          Booking platform fee ${data?.bookingPlatformFeeUsd ?? 0.99} (separate). Production MRR excludes sandbox: $
          {Number(data?.productionMrrUsd || 0).toFixed(2)}. Historical PayPal pro and barber_subscriptions rows are not deleted.
        </p>
        {error ? <p style={{ color: "#f87171" }}>{error}</p> : null}
        <div style={card}>
          <strong style={{ color: gold }}>Catalog</strong>
          <ul>
            <li>ifcdc.barbers.multilocation.monthly — $59.99</li>
            <li>ifcdc.barbers.shop.monthly — $29.99</li>
            <li>ifcdc.barbers.individual.monthly — $9.99</li>
            <li>Google access ifcdc.barbers.access — $0.99 (Play Console; Tessa must create before Android charging)</li>
          </ul>
        </div>
        <div style={card}>
          <strong style={{ color: gold }}>Billing health</strong>
          <p style={{ color: "#a1a1aa", marginTop: 8 }}>
            Verify fail {Number(data?.billingMetrics?.verify_fail || 0)} · Webhook fail{" "}
            {Number(data?.billingMetrics?.webhook_fail || 0)} · Duplicates {Number(data?.billingMetrics?.duplicate || 0)}
            . Counters are process-local (reset on deploy). No tokens or user ids.
          </p>
        </div>
        <div style={card}>
          <strong style={{ color: gold }}>Account subscriptions ({subs.length})</strong>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Plan</th>
                <th style={th}>Status</th>
                <th style={th}>Source</th>
                <th style={th}>User</th>
                <th style={th}>Business</th>
                <th style={th}>Period end</th>
                <th style={th}>Environment</th>
              </tr>
            </thead>
            <tbody>
              {subs.length ? (
                subs.map((row) => (
                  <tr key={row.id}>
                    <td style={td}>{row.plan_key}</td>
                    <td style={td}>{row.status}</td>
                    <td style={td}>{row.source}</td>
                    <td style={td}>{row.user_id || "—"}</td>
                    <td style={td}>{row.business_id || "—"}</td>
                    <td style={td}>{row.current_period_end || row.trial_ends_at || "—"}</td>
                    <td style={td}>{row.store_environment || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td style={td} colSpan={7}>
                    No store-verified subscriptions yet. Production MRR stays $0 until a Production receipt is verified.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={card}>
          <strong style={{ color: gold }}>App access ({access.length})</strong>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>User</th>
                <th style={th}>Platform</th>
                <th style={th}>Product</th>
                <th style={th}>Status</th>
                <th style={th}>Environment</th>
              </tr>
            </thead>
            <tbody>
              {access.length ? (
                access.map((row) => (
                  <tr key={row.id}>
                    <td style={td}>{row.user_id}</td>
                    <td style={td}>{row.platform}</td>
                    <td style={td}>{row.product_id}</td>
                    <td style={td}>{row.status}</td>
                    <td style={td}>{row.store_environment || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td style={td} colSpan={5}>
                    No Android access grants yet. Environment is recorded from Play when a grant exists.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={card}>
          <strong style={{ color: gold }}>Recent events ({events.length})</strong>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Provider</th>
                <th style={th}>Type</th>
                <th style={th}>Processed</th>
              </tr>
            </thead>
            <tbody>
              {events.length ? (
                events.map((row) => (
                  <tr key={row.id}>
                    <td style={td}>{row.created_at}</td>
                    <td style={td}>{row.provider}</td>
                    <td style={td}>{row.event_type}</td>
                    <td style={td}>{String(row.processed)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td style={td} colSpan={4}>
                    No webhook events stored.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => void load()} style={{ background: gold, color: "#111", border: 0, padding: "10px 16px", borderRadius: 8, fontWeight: 800, cursor: "pointer" }}>
          Refresh
        </button>
        <div style={{ marginTop: 16 }}>
          <Link to="/admin" style={{ color: gold, fontWeight: 800 }}>
            ← Admin
          </Link>
        </div>
      </div>
    </div>
  );
}
