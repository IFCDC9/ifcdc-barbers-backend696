import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";
import {
  assignAdminBarberShop,
  deleteAdminBarber,
  fetchAdminBarberDetail,
  fetchAdminBarbers,
  fetchAdminShops,
  patchAdminBarberAccountStatus,
  patchAdminBarberBookingVisibility,
  patchAdminBarberProfile,
  patchAdminBarberSubscription,
  patchAdminBarberVerification,
} from "../services/api.js";
import ProviderTypeDropdown from "../components/ProviderTypeDropdown.jsx";
import { providerTypeLabel } from "../lib/providerTypes.js";

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.colors.border}`,
  backgroundColor: "rgba(0,0,0,0.25)",
  color: theme.colors.text,
  fontSize: 14,
  boxSizing: "border-box",
};

const btnRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 12,
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
    marginBottom: 4,
  };
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function AdminGlobalBarbers() {
  const user = getStoredUser();
  const token = getStoredToken();

  const [shop, setShop] = React.useState("");
  const [city, setCity] = React.useState("");
  const [state, setState] = React.useState("");
  const [active, setActive] = React.useState("");
  const [pendingOnly, setPendingOnly] = React.useState(false);
  const [providerType, setProviderType] = React.useState("");
  const [sort, setSort] = React.useState("newest");
  const [rows, setRows] = React.useState([]);
  const [shops, setShops] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [actionMsg, setActionMsg] = React.useState("");
  const [busyId, setBusyId] = React.useState("");
  const [selected, setSelected] = React.useState(null);
  const [editForm, setEditForm] = React.useState(null);
  const [assignShopId, setAssignShopId] = React.useState("");
  const [subscriptionTier, setSubscriptionTier] = React.useState("free");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await fetchAdminBarbers({
        shop: shop.trim() || undefined,
        city: city.trim() || undefined,
        state: state.trim() || undefined,
        active: active || undefined,
        pendingApproval: pendingOnly ? "true" : undefined,
        sort: sort === "oldest" ? "asc" : sort === "name" || sort === "shop" ? sort : undefined,
        providerType: providerType || undefined,
      });
      setRows(Array.isArray(j?.barbers) ? j.barbers : []);
    } catch (e) {
      setError(e?.message || "Failed to load barbers");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [shop, city, state, active, pendingOnly, sort, providerType]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!user || user.role === "shop_owner") return;
    void fetchAdminShops()
      .then((j) => setShops(Array.isArray(j?.shops) ? j.shops : []))
      .catch(() => setShops([]));
  }, [user]);

  const runAction = async (barberId, fn, successMessage) => {
    setBusyId(barberId);
    setActionMsg("");
    setError("");
    try {
      await fn();
      setActionMsg(successMessage || "Updated.");
      await load();
      if (selected?.id === barberId) {
        const detail = await fetchAdminBarberDetail(barberId);
        setSelected(detail?.barber || null);
      }
    } catch (e) {
      setError(e?.message || "Action failed");
    } finally {
      setBusyId("");
    }
  };

  const openDetails = async (row) => {
    setBusyId(row.id);
    setError("");
    try {
      const detail = await fetchAdminBarberDetail(row.id);
      const barber = detail?.barber || row;
      setSelected(barber);
      setEditForm({
        name: barber.fullName === "—" ? "" : barber.fullName,
        shopName: barber.shopName === "Unassigned" ? "" : barber.shopName,
        email: barber.email === "Not linked" ? "" : barber.email,
        phone: barber.phone || "",
        location: barber.locationLabel === "—" ? "" : barber.locationLabel,
      });
      setAssignShopId(barber.businessId ? String(barber.businessId) : "");
      setSubscriptionTier(barber.subscriptionTier || "free");
    } catch (e) {
      setError(e?.message || "Failed to load barber details");
    } finally {
      setBusyId("");
    }
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
          <ProviderTypeDropdown
            label="Provider type"
            includeAll
            value={providerType}
            onChange={setProviderType}
          />
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
      {actionMsg ? <p style={{ marginTop: 16, color: "#86efac" }}>{actionMsg}</p> : null}
      {!loading && !error && !rows.length ? (
        <p style={{ marginTop: 16, color: theme.colors.muted }}>
          {shop.trim() || city.trim() || state.trim() || active || pendingOnly
            ? "No barbers match these filters."
            : "No barbers found."}
        </p>
      ) : null}

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {rows.map((row) => {
          const isBusy = busyId === row.id;
          const suspended = row.accountStatus === "Suspended";
          return (
            <Card key={row.id}>
              <CardTitle>{row.fullName}</CardTitle>
              <p style={{ margin: "8px 0 0", color: theme.colors.muted, fontSize: 14, lineHeight: 1.6 }}>
                <strong>Shop:</strong> {row.shopName}
                <br />
                <strong>Type:</strong> {providerTypeLabel(row.providerType)}
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
                <strong>Registered:</strong> {formatDate(row.registrationDate)}
              </p>
              <div style={{ marginTop: 10 }}>
                <span style={pillStyle("gold")}>Account: {row.accountStatus}</span>
                <span style={pillStyle("green")}>Subscription: {row.subscriptionStatus}</span>
                <span style={pillStyle(row.verificationStatus === "Pending" ? "gold" : row.verificationStatus === "Rejected" ? "red" : "green")}>
                  Verification: {row.verificationStatus}
                </span>
                {row.bookingHidden ? <span style={pillStyle("gold")}>Hidden from booking</span> : null}
              </div>

              {isSuper ? (
                <div style={btnRowStyle}>
                  <Button variant="ghost" type="button" disabled={isBusy} onClick={() => void openDetails(row)}>
                    View details
                  </Button>
                  <Button
                    variant="indigo"
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void runAction(row.id, async () => {
                        await patchAdminBarberVerification(row.id, "approved");
                        await patchAdminBarberAccountStatus(row.id, "approved");
                      }, `${row.fullName} approved.`)
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void runAction(
                        row.id,
                        () => patchAdminBarberAccountStatus(row.id, suspended ? "active" : "suspended"),
                        suspended ? `${row.fullName} reactivated.` : `${row.fullName} suspended.`,
                      )
                    }
                  >
                    {suspended ? "Reactivate" : "Suspend"}
                  </Button>
                  <Button variant="ghost" type="button" disabled={isBusy} onClick={() => void openDetails(row)}>
                    Edit / assign
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void runAction(
                        row.id,
                        () => patchAdminBarberBookingVisibility(row.id, !row.bookingHidden),
                        row.bookingHidden ? `${row.fullName} is visible for booking again.` : `${row.fullName} hidden from booking.`,
                      )
                    }
                  >
                    {row.bookingHidden ? "Show on booking" : "Hide from booking"}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete ${row.fullName}? Barbers with bookings will be hidden from booking and suspended instead.`,
                        )
                      ) {
                        return;
                      }
                      void runAction(row.id, () => deleteAdminBarber(row.id), "Barber removed or hidden.");
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {selected && editForm ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setSelected(null)}
        >
          <div
            style={{ width: "min(100%, 520px)", maxHeight: "90vh", overflow: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
          <Card style={{ margin: 0 }}>
            <CardTitle>{selected.fullName} — details</CardTitle>
            <p style={{ color: theme.colors.muted, fontSize: 14, lineHeight: 1.6, marginTop: 12 }}>
              <strong>ID:</strong> {selected.id}
              <br />
              <strong>Shop:</strong> {selected.shopName}
              <br />
              <strong>Location:</strong> {selected.locationLabel}
              <br />
              <strong>Email:</strong> {selected.email}
              <br />
              <strong>Registered:</strong> {formatDate(selected.registrationDate)}
              <br />
              <strong>Account:</strong> {selected.accountStatus} · <strong>Verification:</strong> {selected.verificationStatus} ·{" "}
              <strong>Subscription:</strong> {selected.subscriptionStatus}
              {selected.bookingHidden ? (
                <>
                  <br />
                  <strong>Booking:</strong> Hidden from customer booking screens
                </>
              ) : null}
            </p>

            <CardTitle style={{ marginTop: 16, fontSize: 16 }}>Edit barber</CardTitle>
            <input style={inputStyle} placeholder="Full name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            <input style={inputStyle} placeholder="Shop display name" value={editForm.shopName} onChange={(e) => setEditForm({ ...editForm, shopName: e.target.value })} />
            <input style={inputStyle} placeholder="Email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            <input style={inputStyle} placeholder="Phone" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
            <input style={inputStyle} placeholder="Location" value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} />
            <Button
              variant="indigo"
              type="button"
              disabled={busyId === selected.id}
              style={{ marginTop: 8 }}
              onClick={() =>
                void runAction(
                  selected.id,
                  () =>
                    patchAdminBarberProfile(selected.id, {
                      name: editForm.name,
                      shopName: editForm.shopName,
                      email: editForm.email,
                      phone: editForm.phone,
                      location: editForm.location,
                    }),
                  "Barber profile saved.",
                )
              }
            >
              Save changes
            </Button>

            <CardTitle style={{ marginTop: 16, fontSize: 16 }}>Assign to shop / location</CardTitle>
            <select style={inputStyle} value={assignShopId} onChange={(e) => setAssignShopId(e.target.value)}>
              <option value="">Select a shop…</option>
              {shops.map((s) => (
                <option key={s.id} value={s.businessId || s.id}>
                  {s.shopName} {s.locationLabel && s.locationLabel !== "—" ? `(${s.locationLabel})` : ""}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              type="button"
              disabled={!assignShopId || busyId === selected.id}
              style={{ marginTop: 8 }}
              onClick={() => {
                const shopRow = shops.find((s) => String(s.businessId || s.id) === assignShopId);
                void runAction(
                  selected.id,
                  () => assignAdminBarberShop(selected.id, Number(assignShopId), shopRow?.shopName),
                  "Shop assignment saved.",
                );
              }}
            >
              Assign shop
            </Button>

            <CardTitle style={{ marginTop: 16, fontSize: 16 }}>Subscription / access tier</CardTitle>
            <select style={inputStyle} value={subscriptionTier} onChange={(e) => setSubscriptionTier(e.target.value)}>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="elite">Elite</option>
            </select>
            <Button
              variant="ghost"
              type="button"
              disabled={busyId === selected.id}
              style={{ marginTop: 8 }}
              onClick={() =>
                void runAction(
                  selected.id,
                  () => patchAdminBarberSubscription(selected.id, subscriptionTier),
                  "Subscription tier updated.",
                )
              }
            >
              Update subscription
            </Button>

            <Button
              variant="ghost"
              type="button"
              disabled={busyId === selected.id}
              style={{ marginTop: 8 }}
              onClick={() =>
                void runAction(
                  selected.id,
                  () => patchAdminBarberBookingVisibility(selected.id, !selected.bookingHidden),
                  selected.bookingHidden ? "Barber is visible for booking again." : "Barber hidden from customer bookings.",
                )
              }
            >
              {selected.bookingHidden ? "Show on booking" : "Hide from booking"}
            </Button>

            <div style={{ ...btnRowStyle, marginTop: 20 }}>
              <Button variant="ghost" type="button" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </Card>
          </div>
        </div>
      ) : null}
    </Page>
  );
}
