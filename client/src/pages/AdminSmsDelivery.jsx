import { useCallback, useEffect, useState } from "react";
import { getApiOrigin } from "../services/api.js";
import { getStoredToken } from "../lib/authHeaders.js";

const panel = {
  border: "1px solid rgba(212,175,55,.35)",
  borderRadius: 14,
  background: "rgba(15,15,15,.9)",
  padding: 16,
  marginBottom: 16,
};

const selectStyle = {
  border: "1px solid rgba(255,255,255,.16)",
  borderRadius: 9,
  background: "#171717",
  color: "#fff",
  padding: "10px 12px",
  marginRight: 10,
};

/**
 * IFCDC HQ — SMS delivery history (Super Admin).
 * Read-only against GET /api/sms/admin/history. Flags stay off until credentials approved.
 */
export default function AdminSmsDelivery() {
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const authHeaders = useCallback(() => {
    const token = getStoredToken();
    return {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiOrigin()}/api/sms/status`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      setStatus(data);
    } catch (e) {
      setStatus({ ok: false, error: e?.message || String(e) });
    }
  }, [authHeaders]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (category) q.set("category", category);
      const res = await fetch(`${getApiOrigin()}/api/sms/admin/history?${q}`, {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || `HTTP ${res.status}`);
        setMessages([]);
        return;
      }
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (e) {
      setError(e?.message || String(e));
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, category]);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  const flags = status?.flags || {};
  const twilio = status?.twilio || {};

  return (
    <div style={{ maxWidth: 1100, margin: "24px auto", padding: "0 16px", color: "#f5f5f5" }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/admin" style={{ color: "#d4af37" }}>
          ← Admin
        </a>
      </div>
      <h1 style={{ marginTop: 0, color: "#d4af37" }}>SMS delivery</h1>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        Transactional SMS only (bookings, payments, account security). Live send remains disabled until
        credentials are installed and Super Admin enables the flags.
      </p>

      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Configuration</h2>
        <div style={{ display: "grid", gap: 8, fontSize: 14 }}>
          <div>
            SMS verify enabled:{" "}
            <strong style={{ color: flags.verifyEnabled ? "#8f8" : "#f88" }}>
              {flags.verifyEnabled ? "ON" : "OFF"}
            </strong>
          </div>
          <div>
            SMS notifications enabled:{" "}
            <strong style={{ color: flags.notificationsEnabled ? "#8f8" : "#f88" }}>
              {flags.notificationsEnabled ? "ON" : "OFF"}
            </strong>
          </div>
          <div>
            Twilio account: {twilio.accountConfigured ? "configured" : "missing"} · Messaging:{" "}
            {twilio.messagingConfigured ? "configured" : "missing"} · Verify:{" "}
            {twilio.verifyConfigured ? "configured" : "missing"}
          </div>
        </div>
      </div>

      <div style={panel}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={selectStyle}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            <option value="booking_created">booking_created</option>
            <option value="booking_approved">booking_approved</option>
            <option value="booking_rescheduled">booking_rescheduled</option>
            <option value="booking_canceled">booking_canceled</option>
            <option value="booking_completed">booking_completed</option>
            <option value="booking_reminder">booking_reminder</option>
            <option value="payment_success">payment_success</option>
            <option value="payment_failed">payment_failed</option>
            <option value="payment_refunded">payment_refunded</option>
            <option value="security_verify">security_verify</option>
            <option value="consent_help">consent_help</option>
          </select>
          <button
            type="button"
            onClick={() => void loadHistory()}
            disabled={loading}
            style={{
              border: 0,
              borderRadius: 9,
              padding: "10px 14px",
              background: "#d4af37",
              color: "#111",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {error ? <p style={{ color: "#f88" }}>{error}</p> : null}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#d4af37" }}>
                <th style={{ padding: "8px 6px" }}>When</th>
                <th style={{ padding: "8px 6px" }}>Status</th>
                <th style={{ padding: "8px 6px" }}>Category</th>
                <th style={{ padding: "8px 6px" }}>To</th>
                <th style={{ padding: "8px 6px" }}>Booking / payment</th>
                <th style={{ padding: "8px 6px" }}>Error</th>
                <th style={{ padding: "8px 6px" }}>Preview</th>
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 12, color: "#888" }}>
                    No SMS rows yet (expected while flags are off).
                  </td>
                </tr>
              ) : (
                messages.map((m) => (
                  <tr key={m.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {m.created_at ? String(m.created_at).replace("T", " ").slice(0, 19) : "—"}
                    </td>
                    <td style={{ padding: "8px 6px" }}>{m.status || "—"}</td>
                    <td style={{ padding: "8px 6px" }}>{m.category || "—"}</td>
                    <td style={{ padding: "8px 6px" }}>{m.to_e164 || "—"}</td>
                    <td style={{ padding: "8px 6px", fontFamily: "ui-monospace, monospace" }}>
                      {m.booking_id ? String(m.booking_id).slice(0, 8) : "—"}
                      {m.payment_ref ? ` / ${String(m.payment_ref).slice(0, 10)}` : ""}
                    </td>
                    <td style={{ padding: "8px 6px", color: m.error_code ? "#f88" : "#888" }}>
                      {m.error_code || m.error_message || "—"}
                    </td>
                    <td style={{ padding: "8px 6px", maxWidth: 240 }}>{m.body_preview || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
