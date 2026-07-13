import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api.js";
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
const meta = { margin: "4px 0", color: "#a1a1aa", fontSize: 13, wordBreak: "break-all" };

function canRefund(b) {
  const capture = String(b.paypal_capture_id || "").trim();
  if (!capture) return false;
  const status = String(b.payment_status || "").toLowerCase();
  if (["refunded", "partially_refunded", "refund_pending"].includes(status)) return false;
  const paid = Number(b.amount_paid ?? b.amount_charged ?? b.total_paid ?? 0);
  return paid > 0.01 || ["payment_failed", "payment_mismatch", "paid", "paid_full", "paid_in_full"].includes(status);
}

export default function AdminBookings() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet("/api/bookings", { headers: getAdminAuthHeaders() });
      const rows = Array.isArray(data?.bookings) ? data.bookings : Array.isArray(data) ? data : [];
      setBookings(rows);
    } catch (e) {
      console.error("BOOKINGS ERROR:", e);
      setError(e instanceof Error ? e.message : "Failed to load bookings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onRefund = async (booking) => {
    const id = String(booking.id || "");
    if (!id || !canRefund(booking)) return;
    if (!window.confirm(`Refund PayPal capture for booking ${id}?`)) return;
    setBusyId(id);
    setMessage("");
    try {
      await apiPost(
        `/api/admin/bookings/${encodeURIComponent(id)}/refund`,
        { reason: "Admin manual refund from web console" },
        getAdminAuthHeaders(),
      );
      setMessage(`Refund submitted for ${id}`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={wrap}>
      <Link to="/admin" style={back}>
        ← Admin home
      </Link>
      <h2 style={h2}>Shop bookings</h2>
      {message ? <p style={{ color: "#86efac" }}>{message}</p> : null}

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
            const bookingStatus = b.booking_status || b.status || "";
            const paymentStatus = b.payment_status || "";
            return (
              <div key={id} style={card} className="card">
                <p style={{ margin: "0 0 6px" }}>
                  <strong style={{ color: "#fafafa" }}>{name}</strong>
                </p>
                <p style={{ margin: "4px 0", color: "#d4d4d8" }}>{service}</p>
                <p style={{ margin: "4px 0", color: "#a1a1aa", fontSize: 14 }}>
                  {date} @ {time}
                </p>
                <p style={meta}>Booking ID: {id}</p>
                <p style={meta}>
                  Booking status: {bookingStatus || "—"} · Payment: {paymentStatus || "—"}
                  {b.refund_status || b.paypal_refund_id ? ` · Refund: ${b.paypal_refund_id || b.refund_status}` : ""}
                </p>
                {b.paypal_order_id ? <p style={meta}>PayPal Order: {b.paypal_order_id}</p> : null}
                {b.paypal_capture_id ? <p style={meta}>Capture ID: {b.paypal_capture_id}</p> : null}
                {b.paypal_refund_id ? <p style={meta}>Refund ID: {b.paypal_refund_id}</p> : null}
                {b.cancellation_reason || b.refund_reason ? (
                  <p style={meta}>Failure / refund reason: {b.cancellation_reason || b.refund_reason}</p>
                ) : null}
                {canRefund(b) ? (
                  <button
                    type="button"
                    disabled={busyId === id}
                    onClick={() => void onRefund(b)}
                    style={{
                      marginTop: 8,
                      background: "transparent",
                      border: "1px solid #d4af37",
                      color: "#d4af37",
                      padding: "6px 12px",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    {busyId === id ? "Refunding…" : "Manual refund"}
                  </button>
                ) : null}
              </div>
            );
          })
        : null}
    </div>
  );
}
