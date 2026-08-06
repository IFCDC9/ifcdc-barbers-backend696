import React from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import {
  approveAdminShop,
  deleteAdminShop,
  endAdminShopTrial,
  fetchAdminShopDetail,
  patchAdminShop,
  patchAdminShopAccess,
  patchAdminShopAccountStatus,
  rejectAdminShop,
  startAdminShopTrial,
  putAdminShopTelephony,
} from "../services/api.js";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.colors.border}`,
  backgroundColor: "rgba(0,0,0,0.25)",
  color: theme.colors.text,
  fontSize: 14,
  marginBottom: 10,
};

function Section({ title, children }) {
  return (
    <Card style={{ marginTop: 16 }}>
      <CardTitle>{title}</CardTitle>
      <div style={{ marginTop: 12 }}>{children}</div>
    </Card>
  );
}

export default function AdminShopDetail() {
  const { shopId } = useParams();
  const [searchParams] = useSearchParams();
  const user = getStoredUser();
  const token = getStoredToken();
  const isSuper = user?.role === "super_admin" || user?.role === "admin";
  const editMode = searchParams.get("edit") === "1";

  const [detail, setDetail] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [editing, setEditing] = React.useState(editMode);
  const [form, setForm] = React.useState({ name: "", phone: "", city: "", state: "", address: "" });
  const [busy, setBusy] = React.useState(false);
  const [telForm, setTelForm] = React.useState({
    publicPhoneNumber: "",
    twilioPhoneNumber: "",
    twilioPhoneNumberSid: "",
    ownerNotificationPhone: "",
    managerNotificationPhone: "",
    escalationPhone: "",
    customGreeting: "",
    preferredLanguage: "en",
    timezone: "America/New_York",
    shopCode: "",
    voiceEnabled: true,
    smsEnabled: true,
    auraEnabled: true,
    telephonyActive: true,
  });
  const [greetingPreview, setGreetingPreview] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const j = await fetchAdminShopDetail(shopId);
      setDetail(j);
      const s = j?.shop || {};
      setForm({
        name: s.shopName || "",
        phone: s.ownerPhone || "",
        city: s.city || "",
        state: s.state || "",
        address: s.address || "",
      });
      const tel = j?.telephony || {};
      setTelForm({
        publicPhoneNumber: tel.publicPhoneNumber || "",
        twilioPhoneNumber: tel.twilioPhoneNumber || "",
        twilioPhoneNumberSid: tel.twilioPhoneNumberSid || "",
        ownerNotificationPhone: tel.ownerNotificationPhone || "",
        managerNotificationPhone: tel.managerNotificationPhone || "",
        escalationPhone: tel.escalationPhone || "",
        customGreeting: tel.customGreeting || "",
        preferredLanguage: tel.preferredLanguage || "en",
        timezone: tel.timezone || "America/New_York",
        shopCode: tel.shopCode || "",
        voiceEnabled: tel.voiceEnabled !== false,
        smsEnabled: tel.smsEnabled !== false,
        auraEnabled: tel.auraEnabled !== false,
        telephonyActive: tel.telephonyActive !== false,
      });
      setGreetingPreview(j?.greetingPreview || "");
    } catch (e) {
      setError(e?.message || "Failed to load shop");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin" && user.role !== "shop_owner")) {
    return <Navigate to="/login" replace />;
  }

  const shop = detail?.shop;

  const saveEdit = async () => {
    setBusy(true);
    try {
      await patchAdminShop(shopId, {
        name: form.name,
        phone: form.phone,
        city: form.city,
        state: form.state,
        address: form.address,
      });
      setEditing(false);
      await load();
    } catch (e) {
      setError(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const saveTelephony = async () => {
    setBusy(true);
    setError("");
    try {
      const j = await putAdminShopTelephony(shopId, telForm);
      setGreetingPreview(j?.greetingPreview || "");
      await load();
    } catch (e) {
      setError(e?.message || "Telephony save failed");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status) => {
    if (!window.confirm(`${status === "active" ? "Reactivate" : "Suspend"} this shop?`)) return;
    setBusy(true);
    try {
      await patchAdminShopAccountStatus(shopId, status);
      await load();
    } catch (e) {
      setError(e?.message || "Status update failed");
    } finally {
      setBusy(false);
    }
  };

  const removeShop = async () => {
    if (!window.confirm("Delete this shop? Shops with bookings will be disabled instead.")) return;
    setBusy(true);
    try {
      const res = await deleteAdminShop(shopId);
      alert(res?.message || "Shop removed.");
      window.location.href = "/admin/shops";
    } catch (e) {
      setError(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (plan) => {
    setBusy(true);
    try {
      await approveAdminShop(shopId, { plan });
      await load();
    } catch (e) {
      setError(e?.message || "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    const reason = window.prompt("Rejection reason (optional):") || "";
    setBusy(true);
    try {
      await rejectAdminShop(shopId, reason);
      await load();
    } catch (e) {
      setError(e?.message || "Rejection failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleAccess = async (patch) => {
    setBusy(true);
    try {
      await patchAdminShopAccess(shopId, patch);
      await load();
    } catch (e) {
      setError(e?.message || "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={shop?.shopName || "Shop detail"}
        subtitle="Manage barbers, services, bookings, and settings"
        right={
          <Link to="/admin/shops" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← All shops
          </Link>
        }
      />

      {loading ? <p style={{ marginTop: 16, color: theme.colors.muted }}>Loading…</p> : null}
      {error ? <p style={{ marginTop: 16, color: "#f87171" }}>{error}</p> : null}

      {shop ? (
        <>
          <Card style={{ marginTop: 16 }}>
            <CardTitle>Overview</CardTitle>
            <p style={{ color: theme.colors.muted, fontSize: 14, lineHeight: 1.6 }}>
              <strong>Owner:</strong> {shop.ownerName} · {shop.ownerEmail}
              {shop.ownerPhone ? ` · ${shop.ownerPhone}` : ""}
              <br />
              <strong>Location:</strong> {shop.locationLabel}
              <br />
              <strong>Address:</strong> {shop.address}
              <br />
              <strong>Status:</strong> {shop.accountStatus} · <strong>Approval:</strong> {shop.approvalStatus} ·{" "}
              <strong>Plan:</strong> {shop.accessPlan} · <strong>Subscription:</strong> {shop.subscriptionStatus}
              <br />
              <strong>Customers:</strong> {shop.customerCount} · <strong>Barbers:</strong> {shop.barberCount} ·{" "}
              <strong>Bookings:</strong> {shop.bookingCount}
              <br />
              <strong>Revenue:</strong> ${Number(shop.totalRevenue || 0).toFixed(2)} ·{" "}
              <strong>Platform fees:</strong> ${Number(shop.platformFees || 0).toFixed(2)}
              {shop.trialEndsAt ? (
                <>
                  <br />
                  <strong>Trial ends:</strong> {new Date(shop.trialEndsAt).toLocaleString()}
                </>
              ) : null}
            </p>
            {shop.pendingApproval && isSuper ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <Button variant="indigo" type="button" onClick={() => void approve("free")} disabled={busy}>
                  Approve — Free
                </Button>
                <Button variant="ghost" type="button" onClick={() => void approve("trial")} disabled={busy}>
                  Approve — Trial (14 days)
                </Button>
                <Button variant="ghost" type="button" onClick={() => void approve("paid")} disabled={busy}>
                  Approve — Paid
                </Button>
                <Button variant="ghost" type="button" onClick={() => void approve("lifetime_free")} disabled={busy}>
                  Approve — Lifetime free
                </Button>
                <Button variant="ghost" type="button" onClick={() => void reject()} disabled={busy}>
                  Reject
                </Button>
              </div>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
              <Button variant="indigo" type="button" onClick={() => setEditing((v) => !v)} disabled={busy}>
                {editing ? "Cancel edit" : "Edit shop"}
              </Button>
              {isSuper && shop.accountStatus !== "Active" ? (
                <Button variant="ghost" type="button" onClick={() => void setStatus("active")} disabled={busy}>
                  Reactivate
                </Button>
              ) : null}
              {isSuper && shop.accountStatus === "Active" ? (
                <Button variant="ghost" type="button" onClick={() => void setStatus("suspended")} disabled={busy}>
                  Suspend
                </Button>
              ) : null}
              {isSuper ? (
                <Button variant="ghost" type="button" onClick={() => void removeShop()} disabled={busy}>
                  Delete shop
                </Button>
              ) : null}
              <Link to={`/admin/barbers?shop=${encodeURIComponent(shop.shopName)}`}>
                <Button variant="ghost" type="button">
                  View barbers
                </Button>
              </Link>
            </div>
          </Card>

          <Section title="Shop Telephone & AURA Settings">
            <p style={{ color: theme.colors.muted, fontSize: 13, marginBottom: 12 }}>
              Platform shared number remains <strong>+19895141064</strong> / (989) 514-1064. Shop Twilio numbers are
              separate. Numbers are not purchased or released automatically.
            </p>
            {[
              ["publicPhoneNumber", "Public telephone number (E.164)"],
              ["twilioPhoneNumber", "Twilio telephone number (E.164)"],
              ["twilioPhoneNumberSid", "Assigned Twilio SID"],
              ["ownerNotificationPhone", "Owner notification number"],
              ["managerNotificationPhone", "Manager notification number"],
              ["escalationPhone", "Escalation telephone number"],
              ["shopCode", "Shop code / extension"],
              ["timezone", "Timezone"],
              ["preferredLanguage", "Language"],
            ].map(([key, label]) => (
              <label key={key} style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
                {label}
                <input
                  style={inputStyle}
                  value={telForm[key] || ""}
                  onChange={(e) => setTelForm((f) => ({ ...f, [key]: e.target.value }))}
                  disabled={busy || (key.startsWith("twilio") && !isSuper)}
                />
              </label>
            ))}
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              Custom greeting
              <textarea
                style={{ ...inputStyle, minHeight: 72 }}
                value={telForm.customGreeting || ""}
                onChange={(e) => setTelForm((f) => ({ ...f, customGreeting: e.target.value }))}
                disabled={busy}
              />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
              {[
                ["voiceEnabled", "Voice enabled"],
                ["smsEnabled", "SMS enabled"],
                ["auraEnabled", "AURA enabled"],
                ["telephonyActive", "Number active"],
              ].map(([key, label]) => (
                <label key={key} style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(telForm[key])}
                    onChange={(e) => setTelForm((f) => ({ ...f, [key]: e.target.checked }))}
                    disabled={busy}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
            {telForm.publicPhoneNumber || detail?.telephony?.callTelHref ? (
              <p style={{ marginBottom: 10 }}>
                <a href={detail?.telephony?.callTelHref || `tel:${telForm.publicPhoneNumber}`}>
                  Call AURA / shop dialer
                </a>
              </p>
            ) : null}
            {greetingPreview ? (
              <p style={{ color: theme.colors.muted, fontSize: 13, marginBottom: 12 }}>
                <strong>Test greeting:</strong> {greetingPreview}
              </p>
            ) : null}
            <Button variant="indigo" type="button" onClick={() => void saveTelephony()} disabled={busy}>
              Save telephone & AURA settings
            </Button>
          </Section>

          {isSuper ? (
            <Card style={{ marginTop: 16 }}>
              <CardTitle>Platform access controls</CardTitle>
              <p style={{ color: theme.colors.muted, fontSize: 13, marginBottom: 12 }}>
                Bookings: {shop.bookingsEnabled ? "enabled" : "disabled"} · Payments:{" "}
                {shop.paymentProcessingEnabled ? "enabled" : "disabled"} · Platform fees:{" "}
                {shop.platformFeesEnabled !== false ? "on" : "off"} · Subscriptions:{" "}
                {shop.subscriptionEnabled !== false ? "on" : "off"} · Website:{" "}
                {shop.websiteAccessEnabled !== false ? "on" : "off"} · Mobile app:{" "}
                {shop.mobileAppAccessEnabled !== false ? "on" : "off"} · Free access:{" "}
                {shop.freeAccessEnabled ? "on" : "off"} · Paid subscription required:{" "}
                {shop.paidSubscriptionRequired ? "yes" : "no"}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ freeAccessEnabled: !shop.freeAccessEnabled })}
                >
                  {shop.freeAccessEnabled ? "Disable free access" : "Enable free access"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ paidSubscriptionRequired: !shop.paidSubscriptionRequired })}
                >
                  {shop.paidSubscriptionRequired ? "Waive paid requirement" : "Require paid subscription"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ bookingsEnabled: !shop.bookingsEnabled })}
                >
                  {shop.bookingsEnabled ? "Disable bookings" : "Enable bookings"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ paymentProcessingEnabled: !shop.paymentProcessingEnabled })}
                >
                  {shop.paymentProcessingEnabled ? "Disable payments" : "Enable payments"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ platformFeesEnabled: shop.platformFeesEnabled === false })}
                >
                  {shop.platformFeesEnabled === false ? "Enable platform fees" : "Disable platform fees"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ subscriptionEnabled: shop.subscriptionEnabled === false })}
                >
                  {shop.subscriptionEnabled === false ? "Enable subscriptions" : "Disable subscriptions"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ websiteAccessEnabled: shop.websiteAccessEnabled === false })}
                >
                  {shop.websiteAccessEnabled === false ? "Enable website" : "Disable website"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ mobileAppAccessEnabled: shop.mobileAppAccessEnabled === false })}
                >
                  {shop.mobileAppAccessEnabled === false ? "Enable mobile app" : "Disable mobile app"}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleAccess({ accessPlan: "lifetime_free", subscriptionEnabled: false })}
                >
                  Set lifetime free
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        await startAdminShopTrial(shopId, 14);
                        await load();
                      } catch (e) {
                        setError(e?.message || "Trial start failed");
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Start trial
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        await endAdminShopTrial(shopId);
                        await load();
                      } catch (e) {
                        setError(e?.message || "Trial end failed");
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  End trial
                </Button>
              </div>
            </Card>
          ) : null}

          {editing ? (
            <Card style={{ marginTop: 16 }}>
              <CardTitle>Edit shop settings</CardTitle>
              <input style={inputStyle} placeholder="Shop name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input style={inputStyle} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <input style={inputStyle} placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <input style={inputStyle} placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
              <input style={inputStyle} placeholder="Full address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <Button variant="indigo" type="button" onClick={() => void saveEdit()} disabled={busy}>
                Save changes
              </Button>
            </Card>
          ) : null}

          <Section title={`Barbers (${detail.barbers?.length || 0})`}>
            {!detail.barbers?.length ? (
              <p style={{ color: theme.colors.muted }}>No barbers assigned.</p>
            ) : (
              detail.barbers.map((b) => (
                <p key={b.id} style={{ color: theme.colors.muted, margin: "0 0 8px" }}>
                  {b.name} · {b.email || "—"} · {b.verificationStatus}
                </p>
              ))
            )}
          </Section>

          <Section title={`Services & prices (${detail.services?.length || 0})`}>
            {!detail.services?.length ? (
              <p style={{ color: theme.colors.muted }}>No services listed.</p>
            ) : (
              detail.services.slice(0, 20).map((s) => (
                <p key={s.id} style={{ color: theme.colors.muted, margin: "0 0 8px" }}>
                  {s.barberName}: {s.name} — ${Number(s.price).toFixed(2)} ({s.durationMinutes} min)
                  {s.isActive ? "" : " (inactive)"}
                </p>
              ))
            )}
          </Section>

          <Section title={`Style photos (${detail.stylePhotos?.length || 0})`}>
            {!detail.stylePhotos?.length ? (
              <p style={{ color: theme.colors.muted }}>No style photos yet.</p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {detail.stylePhotos.slice(0, 12).map((st) => (
                  <div key={st.id} style={{ width: 100 }}>
                    {st.imageUrl ? (
                      <img src={st.imageUrl} alt={st.title} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 8 }} />
                    ) : (
                      <div style={{ width: 100, height: 100, background: "#222", borderRadius: 8 }} />
                    )}
                    <p style={{ fontSize: 11, color: theme.colors.muted, margin: "4px 0 0" }}>{st.title}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={`Bookings (${detail.bookings?.length || 0})`}>
            {!detail.bookings?.length ? (
              <p style={{ color: theme.colors.muted }}>No bookings yet.</p>
            ) : (
              detail.bookings.slice(0, 15).map((bk) => (
                <p key={bk.id} style={{ color: theme.colors.muted, margin: "0 0 8px" }}>
                  {bk.date || "—"} · {bk.name} · {bk.service} · ${Number(bk.totalPrice).toFixed(2)} ({bk.paymentStatus || "—"})
                </p>
              ))
            )}
          </Section>

          <Section title={`Customers (${detail.customers?.length || 0})`}>
            {!detail.customers?.length ? (
              <p style={{ color: theme.colors.muted }}>No customers yet.</p>
            ) : (
              detail.customers.slice(0, 20).map((c) => (
                <p key={c.email} style={{ color: theme.colors.muted, margin: "0 0 8px" }}>
                  {c.name} · {c.email} {c.phone ? `· ${c.phone}` : ""}
                </p>
              ))
            )}
          </Section>
        </>
      ) : null}
    </Page>
  );
}
