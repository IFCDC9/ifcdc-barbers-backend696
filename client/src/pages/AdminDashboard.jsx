import React from "react";

export default function AdminDashboard() {
  return (
    <div className="page-stack">
      <div className="page-hero">
        <h1>Admin</h1>
        <p className="lead">Operational snapshot — connect roles and live data in the next build.</p>
      </div>
      <div className="grid-cards">
        <div className="card">
          <h3>Barber management</h3>
          <p className="muted" style={{ margin: "0 0 12px" }}>
            Global view of every barber who registers across the platform.
          </p>
          <a href="/admin/barbers" style={{ color: "var(--gold)", fontWeight: 800 }}>
            Open global barber list →
          </a>
        </div>
        <div className="card">
          <h3>Today</h3>
          <p style={{ fontSize: "2rem", margin: "0.25rem 0", fontFamily: "var(--ifcdc-font-display)" }}>—</p>
          <p className="muted" style={{ margin: 0 }}>
            Appointments
          </p>
        </div>
        <div className="card">
          <h3>Revenue</h3>
          <p style={{ fontSize: "2rem", margin: "0.25rem 0", fontFamily: "var(--ifcdc-font-display)" }}>—</p>
          <p className="muted" style={{ margin: 0 }}>
            This week (placeholder)
          </p>
        </div>
        <div className="card">
          <h3>Team</h3>
          <p style={{ fontSize: "2rem", margin: "0.25rem 0", fontFamily: "var(--ifcdc-font-display)" }}>—</p>
          <p className="muted" style={{ margin: 0 }}>
            Active barbers
          </p>
        </div>
        <div className="card">
          <h3>Alerts</h3>
          <p className="muted" style={{ margin: 0 }}>
            No issues — hooks for Twilio, payments, and Supabase land here.
          </p>
        </div>
      </div>
    </div>
  );
}
