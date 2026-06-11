import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  createBarberFormData,
  deleteBarber,
  deleteBarberPhoto,
  deleteBooking as apiDeleteBooking,
  getAdminStats,
  markBookingPaid,
  getBarbers,
  getApiDisplayLabel,
  mediaUrl,
  patchBarber,
  uploadBarberPhoto,
  uploadBarberStyles,
} from "../services/api.js";
import StylesManagement from "../components/StylesManagement.jsx";
import StyleCoverImage from "../components/StyleCoverImage.jsx";
import { UPLOAD_ACCEPT, validateImageUploadFile } from "../lib/imageUploadValidation.js";
import { directionsUrlForShop, mapsEmbedSrcForShop } from "../lib/shopDirections.js";

const pageStyle = {
  background: "#000",
  minHeight: "100vh",
  color: "#d4d4d8",
  padding: "clamp(0.5rem, 2vw, 1rem) 0 clamp(2rem, 6vw, 3rem)",
  boxSizing: "border-box",
  width: "100%",
};

const wrapStyle = {
  width: "100%",
  maxWidth: "min(100%, 60rem)",
  margin: "0 auto",
};

const h1Style = {
  color: "#d4af37",
  textAlign: "center",
  letterSpacing: "0.08em",
  fontSize: "1.75rem",
  marginBottom: 8,
};

const h2Style = {
  color: "#d4af37",
  fontSize: "1.35rem",
  marginTop: 40,
  marginBottom: 16,
  paddingBottom: 10,
  borderBottom: "1px solid rgba(212, 175, 55, 0.35)",
  letterSpacing: "0.04em",
};

const cardStyle = {
  background: "#111",
  padding: 16,
  borderRadius: 10,
  border: "1px solid #333",
  marginBottom: 14,
};

const inputStyle = {
  width: "100%",
  maxWidth: 360,
  padding: "0.55rem 0.7rem",
  marginBottom: 10,
  borderRadius: 8,
  border: "1px solid rgba(212, 175, 55, 0.35)",
  background: "#0a0a0a",
  color: "#fff",
  boxSizing: "border-box",
};

const goldButton = {
  padding: "10px 18px",
  background: "linear-gradient(180deg, #e8c84a, #d4af37)",
  color: "#0a0a0a",
  border: "none",
  borderRadius: 8,
  fontWeight: 700,
  cursor: "pointer",
};

const deleteButton = {
  marginTop: 10,
  padding: "8px 14px",
  background: "#991b1b",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: 600,
};

const muted = { color: "#a1a1aa", fontSize: "0.9rem" };

function formatPaymentStatusLabel(s) {
  if (s === "paid_paypal") return "Fully Paid";
  if (s === "deposit_paypal") return "Deposit paid";
  if (s === "pay_in_person") return "Pay in person";
  return s ? String(s) : "—";
}

/** DB `deposit_paid` or stats-mapped `deposit_paypal`. */
function isDepositPaidBooking(b) {
  const raw = String(b?.rawPaymentStatus || "").toLowerCase();
  if (raw === "deposit_paid") return true;
  return b?.paymentStatus === "deposit_paypal";
}

/** Merge POST /api/bookings/:id/mark-paid row (snake_case) into stats booking row (camelCase). */
function mergeBookingAfterMarkPaid(b, apiRow) {
  if (!apiRow) {
    return {
      ...b,
      rawPaymentStatus: "paid",
      paymentStatus: "paid_paypal",
      remainingBalance: 0,
      amountPaid: Number(b.totalPrice ?? b.price ?? 0),
      totalPaid: Number(b.totalPrice ?? b.price ?? 0) + Number(b.tipAmount ?? 0),
    };
  }
  const totalPrice = Number(apiRow.total_price ?? b.totalPrice ?? b.price ?? 0);
  const tipAmount = Number(apiRow.tip_amount ?? b.tipAmount ?? 0);
  const totalPaid = Number(apiRow.total_paid ?? tipAmount + totalPrice);
  const amountPaid = Number(apiRow.amount_paid ?? totalPrice);
  const remainingBalance = Number(apiRow.remaining_balance ?? 0);
  return {
    ...b,
    rawPaymentStatus: "paid",
    paymentStatus: "paid_paypal",
    totalPrice,
    tipAmount,
    totalPaid,
    amountPaid,
    remainingBalance,
  };
}

function recomputeOutstandingFromBookings(bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const outstandingBalanceAmount = list.reduce((s, x) => s + Number(x.remainingBalance || 0), 0);
  const outstandingBalanceCount = list.filter((x) => Number(x.remainingBalance || 0) > 0).length;
  return { outstandingBalanceAmount, outstandingBalanceCount };
}

function exportPaidBookingsCsv(rows) {
  const headers = [
    "id",
    "name",
    "email",
    "phone",
    "barber",
    "service",
    "styleTitle",
    "totalPrice",
    "depositAmount",
    "amountPaid",
    "remainingBalance",
    "tipAmount",
    "totalPaid",
    "paymentMode",
    "paymentStatus",
    "paymentId",
    "barberAmount",
    "platformAmount",
    "date",
    "time",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const b of rows) {
    const total = b.totalPrice ?? b.price ?? b.amount;
    lines.push(
      [
        esc(b.id),
        esc(b.name),
        esc(b.customerEmail),
        esc(b.phone),
        esc(b.barber),
        esc(b.service),
        esc(b.styleTitle),
        esc(total),
        esc(b.depositAmount),
        esc(b.amountPaid ?? b.price),
        esc(b.remainingBalance),
        esc(b.tipAmount),
        esc(b.totalPaid),
        esc(b.paymentMode),
        esc(b.paymentStatus),
        esc(b.paymentId),
        esc(b.barberAmount ?? b.barberEarnings),
        esc(b.platformAmount ?? b.platformEarnings),
        esc(b.date),
        esc(b.time),
      ].join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ifcdc-paid-bookings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function BarberPaymentSettings({ barber, onSaved, inputStyle, goldButton, muted }) {
  const [mode, setMode] = useState(barber.paymentMode || "platform");
  const [split, setSplit] = useState(() => String(barber.splitPercent ?? 80));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(barber.paymentMode || "platform");
    setSplit(String(barber.splitPercent ?? 80));
  }, [barber.id, barber.paymentMode, barber.splitPercent]);

  const save = async () => {
    const sp = Number(split);
    if (!Number.isFinite(sp) || sp < 0 || sp > 100) {
      alert("Barber share % must be between 0 and 100.");
      return;
    }
    setSaving(true);
    try {
      await patchBarber(barber.id, {
        paymentMode: mode,
        splitPercent: sp,
      });
      await onSaved();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ ...muted, display: "block", marginBottom: 6 }}>Payment mode</label>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        style={{ ...inputStyle, maxWidth: 360 }}
      >
        <option value="platform">Platform (App Payments)</option>
        <option value="direct">Direct (Cash/Zelle)</option>
        <option value="hybrid">Hybrid</option>
      </select>
      <label style={{ ...muted, display: "block", marginTop: 10, marginBottom: 6 }}>
        Barber share % <span style={{ opacity: 0.85 }}>(default 80 — platform keeps 20)</span>
      </label>
      <input
        type="number"
        min={0}
        max={100}
        value={split}
        onChange={(e) => setSplit(e.target.value)}
        style={{ ...inputStyle, maxWidth: 120 }}
      />
      <button
        type="button"
        onClick={save}
        disabled={saving}
        style={{ ...goldButton, display: "block", marginTop: 10 }}
      >
        {saving ? "Saving…" : "Save payment settings"}
      </button>
    </div>
  );
}

function BarberLocationSettings({ barber, onSaved, inputStyle, goldButton, muted }) {
  const [address, setAddress] = useState(() => String(barber?.location?.address ?? ""));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAddress(String(barber?.location?.address ?? ""));
  }, [barber.id, barber?.location?.address]);

  const previewLoc = useMemo(() => {
    const trimmed = String(address || "").trim();
    return trimmed ? { address: trimmed, latitude: null, longitude: null } : barber?.location || {};
  }, [address, barber?.location]);

  const embedSrc = useMemo(() => mapsEmbedSrcForShop(previewLoc), [previewLoc]);
  const dirUrl = useMemo(() => directionsUrlForShop(previewLoc), [previewLoc]);

  const save = async () => {
    setSaving(true);
    try {
      await patchBarber(barber.id, {
        location: {
          address: String(address || "").trim(),
          latitude: null,
          longitude: null,
        },
      });
      await onSaved();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ ...muted, display: "block", marginBottom: 6 }}>Shop location</label>
      <p style={{ ...muted, margin: "0 0 8px", fontSize: "0.88rem", maxWidth: 560 }}>
        Enter the street address. Customers tap <strong style={{ color: "#d4d4d8" }}>Get directions</strong> in the
        app to open Apple or Google Maps — no latitude/longitude needed.
      </p>
      <input
        type="text"
        placeholder="e.g. 123 Main St, Detroit, MI 48201"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        style={{ ...inputStyle, maxWidth: 560 }}
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <button type="button" onClick={save} disabled={saving} style={{ ...goldButton }}>
          {saving ? "Saving…" : "Save address"}
        </button>
      </div>

      {embedSrc ? (
        <div className="map-section" style={{ marginTop: 14 }}>
          <h3 style={{ ...muted, color: "#d4af37", fontSize: "1rem", marginBottom: 8 }}>Map preview</h3>
          <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid rgba(212,175,55,0.22)" }}>
            <iframe
              width="100%"
              height="200"
              style={{ border: 0, display: "block" }}
              loading="lazy"
              allowFullScreen
              src={embedSrc}
              title={`Map preview for ${barber?.name || "barber"}`}
            />
          </div>
          {dirUrl ? (
            <button
              type="button"
              onClick={() => window.open(dirUrl, "_blank", "noopener,noreferrer")}
              style={{
                marginTop: 10,
                width: "100%",
                maxWidth: 560,
                padding: "10px 14px",
                borderRadius: 12,
                border: "1px solid rgba(212,175,55,0.45)",
                background: "rgba(212,175,55,0.12)",
                color: "#f5d97a",
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Open in Maps (directions)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AdminDashboard() {
  const apiLabel = useMemo(() => getApiDisplayLabel(), []);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  const [barbers, setBarbers] = useState([]);
  const [barbersError, setBarbersError] = useState(null);

  const [name, setName] = useState("");
  const [photoFile, setPhotoFile] = useState(null);
  const [creating, setCreating] = useState(false);

  const [styleBusyId, setStyleBusyId] = useState(null);
  const [photoBusyId, setPhotoBusyId] = useState(null);
  /** Prevents double-submit while mark-paid API runs. */
  const [markingPaidId, setMarkingPaidId] = useState(null);

  const loadBarbers = useCallback(async () => {
    try {
      const data = await getBarbers();
      setBarbers(Array.isArray(data) ? data : []);
      setBarbersError(null);
    } catch (err) {
      console.error(err);
      setBarbersError(err?.message || "Failed to load barbers");
      setBarbers([]);
    }
  }, []);

  useEffect(() => {
    loadBarbers();
  }, [loadBarbers]);

  useEffect(() => {
    const onGalleryChanged = () => {
      void loadBarbers();
    };
    window.addEventListener("ifcdc-styles-gallery-changed", onGalleryChanged);
    return () => window.removeEventListener("ifcdc-styles-gallery-changed", onGalleryChanged);
  }, [loadBarbers]);

  /** Live stats: initial load + poll every 5s (silent refresh, no loading flicker). */
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await getAdminStats();
        if (!cancelled) {
          setStats(data);
          setStatsError(null);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setStatsError(err?.message || "Failed to load admin stats");
          setStats(null);
        }
      } finally {
        if (!cancelled) {
          setStatsLoading(false);
        }
      }
    };

    setStatsLoading(true);
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const topServicesSorted = useMemo(() => {
    const raw = stats?.topServices;
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw).sort((a, b) => Number(b[1]) - Number(a[1]));
  }, [stats?.topServices]);

  const filteredPaidBookings = useMemo(() => {
    const rows = Array.isArray(stats?.bookings) ? stats.bookings : [];
    const q = search.trim().toLowerCase();
    return rows.filter((b) => {
      if (dateFilter && String(b.date || "").trim() !== dateFilter) return false;
      if (!q) return true;
      const name = String(b.name || "").toLowerCase();
      const em = String(b.customerEmail || b.email || "").toLowerCase();
      return name.includes(q) || em.includes(q);
    });
  }, [stats, search, dateFilter]);

  const depositBookingsToClose = useMemo(
    () => filteredPaidBookings.filter((b) => isDepositPaidBooking(b)),
    [filteredPaidBookings],
  );

  const handleMarkFullyPaid = async (b) => {
    if (!b?.id) return;
    setMarkingPaidId(String(b.id));
    try {
      const res = await markBookingPaid(b.id);
      const apiRow = res?.booking;
      setStats((prev) => {
        if (!prev || !Array.isArray(prev.bookings)) return prev;
        const bookings = prev.bookings.map((row) =>
          String(row.id) === String(b.id) ? mergeBookingAfterMarkPaid(row, apiRow) : row,
        );
        const { outstandingBalanceAmount, outstandingBalanceCount } = recomputeOutstandingFromBookings(bookings);
        return { ...prev, bookings, outstandingBalanceAmount, outstandingBalanceCount };
      });
      setStatsError(null);
    } catch (err) {
      console.error(err);
      alert("Failed to mark as paid");
    } finally {
      setMarkingPaidId(null);
    }
  };

  const handleAddBarber = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    const formData = new FormData();
    formData.append("name", trimmed);
    if (photoFile) formData.append("photo", photoFile);

    setCreating(true);
    try {
      await createBarberFormData(formData);
      setName("");
      setPhotoFile(null);
      await loadBarbers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Could not add barber");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBarber = async (id) => {
    if (!window.confirm("Delete this barber?")) return;
    try {
      await deleteBarber(id);
      await loadBarbers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Delete failed");
    }
  };

  const handleStyleUpload = async (barberId, fileList) => {
    if (!fileList?.length) return;
    for (const f of Array.from(fileList)) {
      const err = validateImageUploadFile(f);
      if (err) {
        alert(err);
        return;
      }
    }
    setStyleBusyId(barberId);
    try {
      await uploadBarberStyles(barberId, Array.from(fileList));
      await loadBarbers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Style upload failed");
    } finally {
      setStyleBusyId(null);
    }
  };

  const handleBarberPhotoReplace = async (barberId, file) => {
    const err = validateImageUploadFile(file);
    if (err) {
      alert(err);
      return;
    }
    setPhotoBusyId(barberId);
    try {
      await uploadBarberPhoto(barberId, file);
      await loadBarbers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Photo upload failed");
    } finally {
      setPhotoBusyId(null);
    }
  };

  const handleBarberPhotoDelete = async (barberId) => {
    if (!window.confirm("Remove this barber's profile photo?")) return;
    setPhotoBusyId(barberId);
    try {
      await deleteBarberPhoto(barberId);
      await loadBarbers();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Photo delete failed");
    } finally {
      setPhotoBusyId(null);
    }
  };

  const deleteBooking = async (id) => {
    if (!window.confirm("Delete this booking from the admin list?")) return;
    try {
      await apiDeleteBooking(id);
      const data = await getAdminStats();
      setStats(data);
      setStatsError(null);
    } catch (err) {
      console.error("[admin] delete booking failed:", { bookingId: id, error: err?.message || err });
      alert(err?.message || "Could not delete booking");
    }
  };

  return (
    <div style={pageStyle}>
      <div style={wrapStyle}>
        <h1 style={h1Style}>Admin Control Panel</h1>
        <p style={{ ...muted, textAlign: "center", marginBottom: 32 }}>
          API: <code style={{ color: "#d4af37" }}>{apiLabel}</code>
        </p>

        {/* —— Money Dashboard (paid bookings + PayPal) —— */}
        <h2 style={h2Style}>Money &amp; payments</h2>
        <p className="admin-money-live" style={{ ...muted, marginTop: -8, marginBottom: 12 }}>
          Live analytics · refreshes every 5s
        </p>
        {statsLoading ? (
          <p className="ifcdc-loading" style={{ ...muted, marginBottom: 16 }}>
            Loading revenue…
          </p>
        ) : null}
        {statsError ? (
          <p style={{ color: "#fecaca", marginBottom: 16 }}>{statsError}</p>
        ) : null}
        {!statsLoading && stats ? (
          <>
            {stats.totalBookings === 0 ? (
              <p className="admin-money-empty">No revenue yet — system ready.</p>
            ) : null}

            <div className="dashboard">
              <div className="card">
                <h3>Total Revenue (platform)</h3>
                <p>${Number(stats.totalRevenuePlatform ?? stats.totalPlatformEarnings ?? 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Barber Earnings</h3>
                <p>${Number(stats.totalBarberEarnings ?? 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Pending Payments</h3>
                <p>${Number(stats.pendingPaymentsAmount ?? 0).toFixed(2)}</p>
                <p className="admin-money-card__small" style={{ marginTop: 6 }}>
                  {Number(stats.pendingPaymentsCount ?? 0)} booking
                  {Number(stats.pendingPaymentsCount ?? 0) === 1 ? "" : "s"} (pay in person)
                </p>
              </div>
              <div className="card">
                <h3>Outstanding balances</h3>
                <p>${Number(stats.outstandingBalanceAmount ?? 0).toFixed(2)}</p>
                <p className="admin-money-card__small" style={{ marginTop: 6 }}>
                  {Number(stats.outstandingBalanceCount ?? 0)} booking
                  {Number(stats.outstandingBalanceCount ?? 0) === 1 ? "" : "s"} (deposit taken)
                </p>
              </div>
              <div className="card">
                <h3>Gross booking volume</h3>
                <p>${Number(stats.totalRevenue || 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Today&apos;s Revenue</h3>
                <p>${Number(stats.todayRevenue || 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Bookings</h3>
                <p>{stats.totalBookings ?? 0}</p>
              </div>
              <div className="card">
                <h3>Avg booking</h3>
                <p>${Number(stats.avgBooking ?? 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Highest payment</h3>
                <p>${Number(stats.highestPayment ?? 0).toFixed(2)}</p>
              </div>
              <div className="card">
                <h3>Last activity</h3>
                <p className="admin-money-card__small">
                  {stats.lastPaymentAt
                    ? new Date(stats.lastPaymentAt).toLocaleString()
                    : "—"}
                </p>
              </div>
            </div>

            <div className="admin-top-services">
              <h3 className="admin-top-services__title">Top Services</h3>
              {topServicesSorted.length === 0 ? (
                <p style={{ ...muted, margin: "0 0 8px" }}>—</p>
              ) : (
                <ul className="admin-top-services__list">
                  {topServicesSorted.map(([service, count]) => (
                    <li key={service}>
                      <span className="admin-top-services__name">{service}</span>
                      <span className="admin-top-services__count">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="admin-money-toolbar">
              <input
                type="search"
                className="admin-money-toolbar__search"
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search bookings"
              />
              <label className="admin-money-toolbar__date">
                <span>Date</span>
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="admin-money-toolbar__export"
                onClick={() => exportPaidBookingsCsv(filteredPaidBookings)}
                disabled={filteredPaidBookings.length === 0}
              >
                Export CSV
              </button>
            </div>

            {depositBookingsToClose.length > 0 ? (
              <div className="admin-deposit-actions" aria-label="Deposit bookings ready to close">
                <h3 className="admin-deposit-actions__title">Close deposit balances</h3>
                <p className="admin-deposit-actions__hint">
                  After cash or card in the chair, tap <strong>Mark Fully Paid</strong> — the list and table update
                  instantly.
                </p>
                <ul className="admin-deposit-actions__cards">
                  {depositBookingsToClose.map((b) => {
                    const total = b.totalPrice ?? b.price ?? b.amount;
                    const rem = b.remainingBalance ?? 0;
                    const busy = Boolean(markingPaidId);
                    const thisBusy = markingPaidId === String(b.id);
                    return (
                      <li key={`deposit-card-${b.id}`} className="admin-deposit-card">
                        <div className="admin-deposit-card__top">
                          <div>
                            <p className="admin-deposit-card__name">{b.name || "—"}</p>
                            <p className="admin-deposit-card__meta">
                              {b.barber || "—"} · {b.date || "—"} · {b.service || "—"}
                            </p>
                          </div>
                          <span className="admin-deposit-card__badge">Deposit paid</span>
                        </div>
                        <div className="admin-deposit-card__amounts">
                          <span>
                            Base <strong>${Number(total ?? 0).toFixed(2)}</strong>
                          </span>
                          <span>
                            Remaining <strong>${Number(rem ?? 0).toFixed(2)}</strong>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="mark-paid-btn"
                          disabled={busy}
                          onClick={() => handleMarkFullyPaid(b)}
                        >
                          {thisBusy ? "Updating…" : "Mark Fully Paid"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div className="admin-money-table-wrap">
              <table className="admin-money-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Barber</th>
                    <th>Service</th>
                    <th>Style</th>
                    <th>Base</th>
                    <th>Deposit</th>
                    <th>Paid</th>
                    <th>Remaining</th>
                    <th>Tip</th>
                    <th>Collected</th>
                    <th>paymentMode</th>
                    <th>paymentStatus</th>
                    <th>paymentId</th>
                    <th>Barber $</th>
                    <th>Platform $</th>
                    <th>Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredPaidBookings.length === 0 ? (
                    <tr>
                      <td colSpan={18} style={{ textAlign: "center", color: "#a1a1aa" }}>
                        {stats.totalBookings === 0
                          ? "No revenue yet — system ready."
                          : "No paid bookings match your search or date filter."}
                      </td>
                    </tr>
                  ) : (
                    filteredPaidBookings.map((b) => {
                      const total = b.totalPrice ?? b.price ?? b.amount;
                      const dep = b.depositAmount;
                      const paid = b.amountPaid ?? b.price;
                      const rem = b.remainingBalance ?? 0;
                      const tip = b.tipAmount ?? 0;
                      const collected = b.totalPaid ?? (Number(b.amountPaid ?? 0) + Number(tip));
                      const barberAmt = b.barberAmount ?? b.barberEarnings;
                      const platAmt = b.platformAmount ?? b.platformEarnings;
                      const showMarkPaid = isDepositPaidBooking(b);
                      const markBusy = Boolean(markingPaidId);
                      const thisMarkBusy = markingPaidId === String(b.id);
                      const rowBg =
                        b.paymentStatus === "deposit_paypal"
                          ? "rgba(180, 83, 9, 0.14)"
                          : b.paymentStatus === "paid_paypal"
                            ? "rgba(22, 101, 52, 0.12)"
                            : "transparent";
                      return (
                      <tr key={b.id} style={{ backgroundColor: rowBg }}>
                        <td>{b.name}</td>
                        <td className="admin-money-table__email">{b.customerEmail || b.email || "—"}</td>
                        <td>{b.phone || "—"}</td>
                        <td>{b.barber || "—"}</td>
                        <td>{b.service || "—"}</td>
                        <td>{b.styleTitle || "—"}</td>
                        <td>${Number(total ?? 0).toFixed(2)}</td>
                        <td>${Number(dep ?? 0).toFixed(2)}</td>
                        <td>${Number(paid ?? 0).toFixed(2)}</td>
                        <td style={{ fontWeight: Number(rem) > 0 ? 700 : 400 }}>${Number(rem ?? 0).toFixed(2)}</td>
                        <td>${Number(tip ?? 0).toFixed(2)}</td>
                        <td style={{ fontWeight: 700 }}>${Number(collected ?? 0).toFixed(2)}</td>
                        <td>{b.paymentMode || "—"}</td>
                        <td>{formatPaymentStatusLabel(b.paymentStatus)}</td>
                        <td className="admin-money-table__payid">{b.paymentId || "—"}</td>
                        <td>${Number(barberAmt ?? 0).toFixed(2)}</td>
                        <td>${Number(platAmt ?? 0).toFixed(2)}</td>
                        <td>{b.date || "—"}</td>
                        <td className="admin-money-table__actions">
                          {showMarkPaid ? (
                            <button
                              type="button"
                              className="mark-paid-btn mark-paid-btn--table"
                              disabled={markBusy}
                              onClick={() => handleMarkFullyPaid(b)}
                            >
                              {thisMarkBusy ? "Updating…" : "Mark Fully Paid"}
                            </button>
                          ) : null}
                          <button type="button" className="admin-money-table__delete" onClick={() => deleteBooking(b.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {/* —— Barbers Management —— */}
        <h2 style={h2Style}>Barbers Management</h2>
        {barbersError ? (
          <p style={{ color: "#fecaca", marginBottom: 12 }}>{barbersError}</p>
        ) : null}

        <form
          onSubmit={handleAddBarber}
          style={{ ...cardStyle, border: "1px solid rgba(212, 175, 55, 0.22)" }}
        >
          <p style={{ ...muted, marginTop: 0, marginBottom: 12 }}>Add a barber with optional profile photo.</p>
          <input
            type="text"
            placeholder="Barber Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
          <div style={{ marginBottom: 12 }}>
            <label style={{ ...muted, display: "block", marginBottom: 6 }}>Profile image</label>
            <input
              type="file"
              accept={UPLOAD_ACCEPT}
              onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
              style={{ color: "#ccc" }}
            />
          </div>
          <button type="submit" disabled={creating} style={{ ...goldButton, opacity: creating ? 0.7 : 1 }}>
            {creating ? "Adding…" : "Add Barber"}
          </button>
        </form>

        {barbers.length === 0 && !barbersError ? (
          <p style={{ ...muted, textAlign: "center" }}>No barbers yet.</p>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {barbers.map((barber) => {
            const portrait = barber.photo || barber.image;
            return (
              <div key={barber.id} style={cardStyle}>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {portrait ? (
                    <StyleCoverImage
                      barberId={barber.id}
                      imageUrl={portrait}
                      alt={barber.name || "Barber"}
                      className="ifcdc-cover-fill"
                      frameClassName="ifcdc-cover-media"
                      frameStyle={{
                        width: 108,
                        height: 108,
                        borderRadius: 10,
                        border: "1px solid #333",
                        overflow: "hidden",
                      }}
                      logContext="admin-barber-portrait"
                    />
                  ) : (
                    <div
                      style={{
                        width: 108,
                        height: 108,
                        borderRadius: 10,
                        background: "#1a1a1a",
                        border: "1px dashed #444",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#666",
                        fontSize: 12,
                      }}
                    >
                      No photo
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <h3 style={{ color: "#d4af37", margin: "0 0 6px", fontSize: "1.15rem" }}>{barber.name}</h3>
                    <p style={{ ...muted, margin: 0, fontSize: "0.8rem" }}>ID: {barber.id}</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, marginBottom: 8 }}>
                      <label style={{ ...muted, fontSize: "0.8rem" }}>
                        {photoBusyId === barber.id ? "Updating photo…" : "Replace photo"}
                        <input
                          type="file"
                          accept={UPLOAD_ACCEPT}
                          disabled={photoBusyId === barber.id}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleBarberPhotoReplace(barber.id, f);
                            e.target.value = "";
                          }}
                          style={{ display: "block", marginTop: 4, color: "#ccc" }}
                        />
                      </label>
                      {portrait ? (
                        <button
                          type="button"
                          style={deleteButton}
                          disabled={photoBusyId === barber.id}
                          onClick={() => handleBarberPhotoDelete(barber.id)}
                        >
                          Remove photo
                        </button>
                      ) : null}
                    </div>
                    <button type="button" style={deleteButton} onClick={() => handleDeleteBarber(barber.id)}>
                      Delete
                    </button>
                    <BarberPaymentSettings
                      barber={barber}
                      onSaved={loadBarbers}
                      inputStyle={inputStyle}
                      goldButton={goldButton}
                      muted={muted}
                    />
                    <BarberLocationSettings
                      barber={barber}
                      onSaved={loadBarbers}
                      inputStyle={inputStyle}
                      goldButton={goldButton}
                      muted={muted}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* —— Upload Photos (style images) —— */}
        <h2 style={h2Style}>Upload Photos</h2>
        <p style={{ ...muted, marginBottom: 16 }}>
          Upload multiple style / portfolio images per barber (field name <code style={{ color: "#d4af37" }}>styles</code>
          ).
        </p>
        {barbers.length === 0 ? (
          <p style={{ ...muted }}>Add a barber first.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {barbers.map((barber) => (
              <div key={`upload-${barber.id}`} style={cardStyle}>
                <strong style={{ color: "#d4af37" }}>{barber.name}</strong>
                <input
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  multiple
                  disabled={styleBusyId === barber.id}
                  onChange={(e) => {
                    handleStyleUpload(barber.id, e.target.files);
                    e.target.value = "";
                  }}
                  style={{ display: "block", marginTop: 10, color: "#ccc" }}
                />
                {styleBusyId === barber.id ? (
                  <p style={{ ...muted, marginBottom: 0 }}>Uploading…</p>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* —— Styles Management —— */}
        <h2 style={h2Style}>Styles Management</h2>
        <p style={{ ...muted, marginBottom: 16 }}>Gallery for each barber&apos;s uploaded styles.</p>
        {barbers.length === 0 ? (
          <p style={{ ...muted }}>No styles to show yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {barbers.map((barber) => (
              <div key={`styles-${barber.id}`} style={cardStyle}>
                <h3 style={{ color: "#d4af37", marginTop: 0, fontSize: "1.05rem" }}>{barber.name}</h3>
                {Array.isArray(barber.styles) && barber.styles.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {barber.styles.map((src) => (
                      <img
                        key={src}
                        src={mediaUrl(src)}
                        alt=""
                        style={{
                          width: 88,
                          height: 88,
                          objectFit: "cover",
                          borderRadius: 8,
                          border: "1px solid #333",
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p style={{ ...muted, margin: 0 }}>No style images yet.</p>
                )}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

export default function Admin() {
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem("user"));
  } catch {
    user = null;
  }

  if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
    return <Navigate to="/login" replace />;
  }

  return (
    <>
      <AdminDashboard />
      <div style={{ ...pageStyle, paddingTop: 0 }}>
        <div style={wrapStyle}>
          <StylesManagement />
        </div>
      </div>
    </>
  );
}
