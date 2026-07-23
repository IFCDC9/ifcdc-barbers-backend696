import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStoredUser, getAdminAuthHeaders } from "../lib/authHeaders.js";
import { getApiOrigin } from "../services/api.js";

const pageStyle = {
  minHeight: "100vh",
  background: "#0a0a0a",
  color: "#f5f5f5",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  padding: "24px 16px 64px",
};
const wrapStyle = { maxWidth: 720, margin: "0 auto" };
const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#141414",
  border: "1px solid #333",
  borderRadius: 10,
  color: "#fff",
  padding: "12px 14px",
  marginBottom: 10,
};
const labelStyle = { display: "block", color: "#d4af37", fontSize: 12, fontWeight: 700, margin: "14px 0 6px" };
const cardStyle = {
  background: "#161616",
  border: "1px solid #2a2a2a",
  borderRadius: 12,
  padding: 14,
  marginBottom: 8,
  cursor: "pointer",
};

const PAYMENT_OPTIONS = [
  { id: "paid_online", title: "Paid Online", subtitle: "PayPal checkout · platform fee applies" },
  { id: "complimentary", title: "Complimentary", subtitle: "No charge · confirmation email sent" },
  { id: "pay_at_shop", title: "Pay at Shop", subtitle: "Confirmed · collect payment in person" },
  { id: "staff_training", title: "Staff / Training", subtitle: "Blocks calendar · no payment" },
];

function isSuperAdminUser(user) {
  if (!user) return false;
  if (user.isSuperAdmin === true || user.isOwner === true) return true;
  return String(user.role || "").toLowerCase() === "super_admin";
}

export default function AdminManualBooking() {
  const [user, setUser] = useState(null);
  const [paymentType, setPaymentType] = useState("pay_at_shop");
  const [barbers, setBarbers] = useState([]);
  const [barberId, setBarberId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [service, setService] = useState("Haircut");
  const [price, setPrice] = useState("35");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00 AM");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setUser(getStoredUser());
    (async () => {
      try {
        const origin = getApiOrigin();
        const res = await fetch(`${origin}/api/app-bookings/barbers`, {
          headers: { Accept: "application/json" },
        });
        const json = await res.json();
        const list = Array.isArray(json) ? json : json?.barbers || [];
        const mapped = list
          .map((b) => ({ id: String(b.id || b.barberId || ""), name: String(b.name || b.barberName || "Barber") }))
          .filter((b) => b.id);
        setBarbers(mapped);
        if (mapped[0]) setBarberId(mapped[0].id);
      } catch (e) {
        setError(e?.message || "Could not load barbers");
      }
    })();
  }, []);

  const allowed = useMemo(() => isSuperAdminUser(user), [user]);
  const selectedBarber = barbers.find((b) => b.id === barberId);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!allowed) {
      setError("Super Admin only.");
      return;
    }
    setBusy(true);
    try {
      const origin = getApiOrigin();
      const res = await fetch(`${origin}/api/admin/manual-bookings`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...getAdminAuthHeaders(),
        },
        body: JSON.stringify({
          paymentType,
          barberId,
          barberName: selectedBarber?.name,
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim().toLowerCase(),
          createClient: true,
          service: service.trim() || "Appointment",
          price: Number(price) || 0,
          date,
          time,
          notes: notes.trim() || undefined,
          reason: reason.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.message || `HTTP ${res.status}`);
      setMessage(`Booking created: ${json.booking?.id || "ok"}`);
      if (json.paypal?.approveUrl) {
        window.open(json.paypal.approveUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(err?.message || "Create failed");
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div style={pageStyle}>
        <div style={wrapStyle}>
          <h1 style={{ color: "#d4af37" }}>Book for Client</h1>
          <p style={{ color: "#aaa" }}>This tool is restricted to the Super Admin account.</p>
          <Link to="/admin" style={{ color: "#d4af37" }}>← Back to Admin</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={wrapStyle}>
        <Link to="/admin" style={{ color: "#d4af37", textDecoration: "none" }}>← Admin</Link>
        <h1 style={{ color: "#d4af37", marginTop: 12 }}>Book for Client</h1>
        <p style={{ color: "#888", marginTop: 0 }}>Manual Booking · Bypass Mode · Super Admin only</p>

        <form onSubmit={onSubmit}>
          <label style={labelStyle}>Payment type</label>
          {PAYMENT_OPTIONS.map((opt) => (
            <div
              key={opt.id}
              role="button"
              tabIndex={0}
              onClick={() => setPaymentType(opt.id)}
              onKeyDown={(ev) => ev.key === "Enter" && setPaymentType(opt.id)}
              style={{
                ...cardStyle,
                borderColor: paymentType === opt.id ? "#d4af37" : "#2a2a2a",
              }}
            >
              <div style={{ fontWeight: 700 }}>{opt.title}</div>
              <div style={{ color: "#888", fontSize: 13 }}>{opt.subtitle}</div>
            </div>
          ))}

          <label style={labelStyle}>Barber</label>
          <select style={inputStyle} value={barberId} onChange={(ev) => setBarberId(ev.target.value)} required>
            {barbers.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>

          <label style={labelStyle}>Client name</label>
          <input style={inputStyle} value={customerName} onChange={(ev) => setCustomerName(ev.target.value)} required />

          <label style={labelStyle}>Client email</label>
          <input
            style={inputStyle}
            type="email"
            value={customerEmail}
            onChange={(ev) => setCustomerEmail(ev.target.value)}
            required
          />

          <label style={labelStyle}>Service</label>
          <input style={inputStyle} value={service} onChange={(ev) => setService(ev.target.value)} />

          <label style={labelStyle}>Price (USD)</label>
          <input
            style={inputStyle}
            value={price}
            onChange={(ev) => setPrice(ev.target.value)}
            disabled={paymentType === "complimentary" || paymentType === "staff_training"}
          />

          <label style={labelStyle}>Date</label>
          <input style={inputStyle} type="date" value={date} onChange={(ev) => setDate(ev.target.value)} required />

          <label style={labelStyle}>Time</label>
          <input style={inputStyle} value={time} onChange={(ev) => setTime(ev.target.value)} placeholder="10:00 or 1:00 PM" required />

          <label style={labelStyle}>Appointment notes</label>
          <textarea style={{ ...inputStyle, minHeight: 72 }} value={notes} onChange={(ev) => setNotes(ev.target.value)} />

          <label style={labelStyle}>Bypass reason (audit)</label>
          <textarea style={{ ...inputStyle, minHeight: 72 }} value={reason} onChange={(ev) => setReason(ev.target.value)} />

          {error ? <p style={{ color: "#fecaca" }}>{error}</p> : null}
          {message ? <p style={{ color: "#86efac" }}>{message}</p> : null}

          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 8,
              width: "100%",
              background: "#d4af37",
              color: "#111",
              border: "none",
              borderRadius: 12,
              padding: "14px 16px",
              fontWeight: 800,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            {busy ? "Creating…" : "Create booking"}
          </button>
        </form>
      </div>
    </div>
  );
}
