import React from "react";
import { Link } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { apiGet, apiPut, apiPost, apiDelete, apiUrl, fetchWithTimeout } from "../lib/api.js";
import {
  mediaUrl,
  uploadServicePhotos,
  setServicePhotoPrimary,
  reorderServicePhotos,
  deleteServicePhoto,
} from "../services/api.js";
import { getServiceCardImageUrl } from "../lib/styleImageUrl.js";

function authHeaders() {
  try {
    const token = window.localStorage.getItem("token");
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* ignore */
  }
  return {};
}

function readUser() {
  try {
    return JSON.parse(window.localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

function defaultWeekAvailability() {
  return [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
    day_of_week,
    start_time: "09:00",
    end_time: "18:00",
    is_off: day_of_week === 0 || day_of_week === 6,
  }));
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const tabBtn = (active) => ({
  padding: "10px 14px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${active ? theme.colors.indigoBorder : theme.colors.border}`,
  background: active ? theme.colors.indigoBg : theme.colors.subtle,
  color: theme.colors.text,
  fontWeight: 800,
  fontSize: 13,
  cursor: "pointer",
});

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.colors.border}`,
  backgroundColor: "rgba(0,0,0,0.25)",
  color: theme.colors.text,
  fontSize: 14,
};

export default function BarberSettings() {
  const user = readUser();
  const role = String(user?.role || "");
  const isAdmin = role === "admin" || role === "super_admin";

  const [tab, setTab] = React.useState("profile");
  const [adminBarberId, setAdminBarberId] = React.useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("ifcdc_admin_barber_id") || "";
  });
  const [barberList, setBarberList] = React.useState([]);
  const [status, setStatus] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const [profile, setProfile] = React.useState({
    name: "",
    bio: "",
    profile_image: "",
    logo: "",
    location: "",
    phone: "",
    shop_name: "",
    portfolio_headline: "",
    years_experience: "",
    business_address: "",
    business_city: "",
    business_state: "",
  });
  const [services, setServices] = React.useState([]);
  const [svcDraft, setSvcDraft] = React.useState({ name: "", price: "25", duration_minutes: "30" });
  const [svcImageFile, setSvcImageFile] = React.useState(null);
  const [svcImageBusy, setSvcImageBusy] = React.useState(false);
  const [availability, setAvailability] = React.useState(() => defaultWeekAvailability());
  const [settings, setSettings] = React.useState({
    theme_color: "#FFD700",
    booking_deposit_enabled: false,
    deposit_amount: 10,
    payment_method: "paypal",
    aura_enabled: true,
    aura_voice_type: "Polly.Joanna",
    language: "en",
    subscription_tier: "pro",
    subscription_monthly_price: "",
    billing_provider: "none",
    billing_subscription_id: "",
  });
  const [clients, setClients] = React.useState([]);
  const [clientDraft, setClientDraft] = React.useState({ name: "", phone: "", notes: "" });
  const [media, setMedia] = React.useState([]);
  const [mediaFile, setMediaFile] = React.useState(null);
  const [profileImageBusy, setProfileImageBusy] = React.useState(false);
  const [logoBusy, setLogoBusy] = React.useState(false);

  const scopeQuery = React.useMemo(() => {
    if (!isAdmin) return "";
    const id = String(adminBarberId || "").trim();
    return id ? `?barberId=${encodeURIComponent(id)}` : "";
  }, [isAdmin, adminBarberId]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("ifcdc_admin_barber_id", String(adminBarberId || ""));
  }, [adminBarberId]);

  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const j = await apiGet("/api/barber/list", { headers: authHeaders() });
        if (!cancelled && Array.isArray(j?.barbers)) {
          setBarberList(j.barbers);
          if (!adminBarberId && j.barbers[0]?.id != null) {
            setAdminBarberId(String(j.barbers[0].id));
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const loadAll = React.useCallback(async () => {
    if (isAdmin && !String(adminBarberId || "").trim()) {
      setStatus("Select a barber (admin).");
      return;
    }
    setLoading(true);
    setStatus("");
    const h = authHeaders();
    const q = scopeQuery;
    try {
      const [p, s, a, st, c, m] = await Promise.all([
        apiGet(`/api/barber/profile${q}`, { headers: h }),
        apiGet(`/api/barber/services${q}`, { headers: h }),
        apiGet(`/api/barber/availability${q}`, { headers: h }),
        apiGet(`/api/barber/settings${q}`, { headers: h }),
        apiGet(`/api/barber/clients${q}`, { headers: h }),
        apiGet(`/api/barber/media${q}`, { headers: h }),
      ]);
      const pr = p?.profile || {};
      setProfile({
        name: pr.name || "",
        bio: pr.bio || "",
        profile_image: pr.profile_image || "",
        logo: pr.logo || "",
        location: pr.location || "",
        phone: pr.phone || "",
        shop_name: pr.shop_name || pr.business_name || "",
        portfolio_headline: pr.portfolio_headline || "",
        years_experience: pr.years_experience != null && pr.years_experience > 0 ? String(pr.years_experience) : "",
        business_address: pr.business_address || "",
        business_city: pr.business_city || "",
        business_state: pr.business_state || "",
      });
      setServices(Array.isArray(s?.services) ? s.services : []);
      const av = Array.isArray(a?.availability) ? a.availability : [];
      setAvailability(av.length ? av : defaultWeekAvailability());
      const se = st?.settings || {};
      const tier = String(se.subscription_tier || "pro").toLowerCase();
      const smp = se.subscription_monthly_price;
      setSettings({
        theme_color: se.theme_color || "#FFD700",
        booking_deposit_enabled: Boolean(se.booking_deposit_enabled),
        deposit_amount: Number(se.deposit_amount) || 0,
        payment_method: se.payment_method || "paypal",
        aura_enabled: se.aura_enabled !== false,
        aura_voice_type: se.aura_voice_type || "Polly.Joanna",
        language: se.language || "en",
        subscription_tier: tier === "elite" ? "elite" : tier === "free" ? "free" : "pro",
        subscription_monthly_price:
          smp != null && smp !== "" && Number.isFinite(Number(smp)) ? String(smp) : "",
        billing_provider: String(se.billing_provider || "none").toLowerCase(),
        billing_subscription_id: se.billing_subscription_id != null ? String(se.billing_subscription_id) : "",
      });
      setClients(Array.isArray(c?.clients) ? c.clients : []);
      setMedia(Array.isArray(m?.media) ? m.media : []);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, adminBarberId, scopeQuery]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  const quickLinksCard = (
    <Card style={{ marginTop: 16 }}>
      <CardTitle>Quick links</CardTitle>
      <p style={{ fontSize: 13, color: theme.colors.muted, marginTop: 8, marginBottom: 12 }}>
        Customer booking reads live deposit rules from this shop via the public pricing API once you save.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <Link to="/booking" style={{ color: theme.colors.text, fontWeight: 800, fontSize: 14 }}>
          Open booking →
        </Link>
        <Link to="/styles" style={{ color: theme.colors.text, fontWeight: 800, fontSize: 14 }}>
          Browse styles →
        </Link>
        <button
          type="button"
          onClick={() => loadAll()}
          style={{
            background: "transparent",
            border: `1px solid ${theme.colors.border}`,
            color: theme.colors.muted,
            fontWeight: 800,
            fontSize: 13,
            padding: "8px 12px",
            borderRadius: theme.radius.sm,
            cursor: "pointer",
          }}
        >
          Reload data
        </button>
      </div>
    </Card>
  );

  const saveProfile = async () => {
    setStatus("");
    try {
      const payload = {
        ...profile,
        years_experience: profile.years_experience === "" ? null : Number(profile.years_experience),
      };
      await apiPut(`/api/barber/profile${scopeQuery}`, payload, authHeaders());
      setStatus("Profile saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    }
  };

  const BRANDING_MAX_BYTES = 5 * 1024 * 1024;
  const BRANDING_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/avif";

  const uploadBrandingFile = async (file) => {
    if (!file) return null;
    if (!/^image\/(jpeg|pjpeg|png|gif|webp|avif)$/i.test(file.type)) {
      throw new Error("Please choose a JPEG, PNG, GIF, WebP, or AVIF image.");
    }
    if (file.size > BRANDING_MAX_BYTES) {
      throw new Error("Image must be 5MB or smaller.");
    }
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetchWithTimeout(apiUrl(`/api/upload${scopeQuery}`), {
      method: "POST",
      headers: authHeaders(),
      body: fd,
      timeoutMs: 120000,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.message || j?.error || `Upload failed (HTTP ${r.status})`);
    const url = j?.url != null ? String(j.url).trim() : "";
    if (!url) throw new Error("Server did not return an image URL.");
    return url;
  };

  const saveSettings = async () => {
    setStatus("");
    try {
      await apiPut(`/api/barber/settings${scopeQuery}`, settings, authHeaders());
      setStatus("Settings saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    }
  };

  const saveAvailability = async () => {
    setStatus("");
    try {
      await apiPut(`/api/barber/availability${scopeQuery}`, { availability }, authHeaders());
      setStatus("Schedule saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    }
  };

  const addService = async () => {
    setStatus("");
    const name = svcDraft.name.trim();
    if (!name) {
      setStatus("Service name required.");
      return;
    }
    setSvcImageBusy(true);
    try {
      let image_url = "";
      if (svcImageFile) {
        image_url = await uploadBrandingFile(svcImageFile);
      }
      await apiPost(
        `/api/barber/services${scopeQuery}`,
        {
          name,
          price: Number(svcDraft.price),
          duration_minutes: Number(svcDraft.duration_minutes),
          ...(image_url ? { image_url } : {}),
        },
        authHeaders(),
      );
      setSvcDraft({ name: "", price: "25", duration_minutes: "30" });
      setSvcImageFile(null);
      await loadAll();
      setStatus("Service saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Add failed");
    } finally {
      setSvcImageBusy(false);
    }
  };

  const uploadServicePhotoFiles = async (serviceId, fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    setStatus("");
    setSvcImageBusy(true);
    try {
      const result = await uploadServicePhotos(serviceId, files, scopeQuery);
      await loadAll();
      const n = Array.isArray(result) ? result.length : 1;
      setStatus(n > 1 ? `${n} photos saved successfully.` : "Photo saved successfully.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Photo upload failed");
    } finally {
      setSvcImageBusy(false);
    }
  };

  const makeServicePhotoPrimary = async (serviceId, galleryId) => {
    setSvcImageBusy(true);
    setStatus("");
    try {
      await setServicePhotoPrimary(serviceId, galleryId, scopeQuery);
      await loadAll();
      setStatus("Primary photo updated.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not set primary photo");
    } finally {
      setSvcImageBusy(false);
    }
  };

  const removeServicePhoto = async (serviceId, photoId) => {
    setSvcImageBusy(true);
    setStatus("");
    try {
      await deleteServicePhoto(serviceId, photoId, scopeQuery);
      await loadAll();
      setStatus("Photo deleted.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSvcImageBusy(false);
    }
  };

  const moveServicePhoto = async (serviceId, photos, index, delta) => {
    const next = [...photos];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    const tmp = next[index];
    next[index] = next[j];
    next[j] = tmp;
    setSvcImageBusy(true);
    setStatus("");
    try {
      await reorderServicePhotos(
        serviceId,
        next.map((p) => p.id),
        scopeQuery,
      );
      await loadAll();
      setStatus("Photo order updated.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Reorder failed");
    } finally {
      setSvcImageBusy(false);
    }
  };

  const removeService = async (id) => {
    setStatus("");
    try {
      await apiDelete(`/api/barber/services/${id}${scopeQuery}`, authHeaders());
      await loadAll();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const addClient = async () => {
    setStatus("");
    if (!clientDraft.name.trim()) {
      setStatus("Client name required.");
      return;
    }
    try {
      await apiPost(`/api/barber/clients${scopeQuery}`, clientDraft, authHeaders());
      setClientDraft({ name: "", phone: "", notes: "" });
      await loadAll();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Add failed");
    }
  };

  const uploadMedia = async () => {
    setStatus("");
    if (!mediaFile) {
      setStatus("Choose an image.");
      return;
    }
    const fd = new FormData();
    fd.append("image", mediaFile);
    try {
      const r = await fetchWithTimeout(apiUrl(`/api/barber/media${scopeQuery}`), {
        method: "POST",
        headers: authHeaders(),
        body: fd,
        timeoutMs: 120000,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      setMediaFile(null);
      await loadAll();
      setStatus("Image uploaded.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const removeMedia = async (id) => {
    setStatus("");
    try {
      await apiDelete(`/api/barber/media/${id}${scopeQuery}`, authHeaders());
      await loadAll();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const updateDay = (idx, patch) => {
    setAvailability((prev) => {
      const next = [...prev];
      const row = next.find((r) => Number(r.day_of_week) === idx);
      if (row) Object.assign(row, patch);
      else next.push({ day_of_week: idx, start_time: "09:00", end_time: "18:00", is_off: false, ...patch });
      return [...next];
    });
  };

  const renderDayRow = (d) => {
    const row = availability.find((r) => Number(r.day_of_week) === d) || {
      day_of_week: d,
      start_time: "09:00",
      end_time: "18:00",
      is_off: false,
    };
    return (
      <div
        key={d}
        style={{
          display: "grid",
          gridTemplateColumns: "72px 1fr 1fr 1fr",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 800, color: theme.colors.text }}>{DAY_LABELS[d]}</div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: theme.colors.muted, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={Boolean(row.is_off)}
            onChange={(e) => updateDay(d, { is_off: e.target.checked })}
          />
          Off
        </label>
        <input
          style={inputStyle}
          value={row.start_time || ""}
          onChange={(e) => updateDay(d, { start_time: e.target.value })}
          placeholder="09:00"
        />
        <input
          style={inputStyle}
          value={row.end_time || ""}
          onChange={(e) => updateDay(d, { end_time: e.target.value })}
          placeholder="18:00"
        />
      </div>
    );
  };

  const tabs = [
    { id: "profile", label: "Profile" },
    { id: "services", label: "Services" },
    { id: "schedule", label: "Schedule" },
    { id: "payments", label: "Payments" },
    { id: "media", label: "Media" },
    { id: "aura", label: "AI (AURA)" },
    { id: "clients", label: "Clients" },
  ];

  return (
    <Page>
      <PageHeader
        title="Shop dashboard"
        subtitle="Barber settings — profile, services, weekly hours, PayPal deposits, portfolio images, AURA voice, and client notes."
        right={
          isAdmin ? (
            <label style={{ display: "grid", gap: 6, minWidth: 200 }}>
              <span style={{ fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>Barber (admin)</span>
              <select
                value={adminBarberId}
                onChange={(e) => setAdminBarberId(e.target.value)}
                style={inputStyle}
              >
                {barberList.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    #{b.id} — {b.name || "Unnamed"}
                  </option>
                ))}
              </select>
            </label>
          ) : null
        }
      />

      {quickLinksCard}

      <section className="ifcdc-profile-account ifcdc-profile-account--shop" aria-label="Account settings">
        <h2 className="ifcdc-book-wizard__heading">Account</h2>
        <Link to="/profile/delete-account" className="ifcdc-delete-account__nav-btn">
          Delete account permanently
        </Link>
        <p className="ifcdc-page-hint ifcdc-delete-account__hint">
          Permanently remove your IFCDC sign-in and personal data. Type DELETE to confirm on the next screen.
        </p>
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {status ? (
        <p style={{ marginTop: 12, color: theme.colors.muted, fontSize: 14 }} role="status">
          {status}
        </p>
      ) : null}
      {loading ? (
        <p style={{ marginTop: 8, color: theme.colors.muted }} role="status">
          Loading…
        </p>
      ) : null}

      {tab === "profile" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Profile</CardTitle>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Name
              <input style={inputStyle} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Portfolio headline
              <input
                style={inputStyle}
                value={profile.portfolio_headline}
                onChange={(e) => setProfile({ ...profile, portfolio_headline: e.target.value })}
                placeholder="e.g. Master barber · fades & beard work"
              />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Years of experience
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={80}
                value={profile.years_experience}
                onChange={(e) => setProfile({ ...profile, years_experience: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Shop name
              <input style={inputStyle} value={profile.shop_name} onChange={(e) => setProfile({ ...profile, shop_name: e.target.value })} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Bio
              <textarea
                style={{ ...inputStyle, minHeight: 100 }}
                value={profile.bio}
                onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Phone
              <input style={inputStyle} value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Street address
              <input style={inputStyle} value={profile.business_address} onChange={(e) => setProfile({ ...profile, business_address: e.target.value })} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                City
                <input style={inputStyle} value={profile.business_city} onChange={(e) => setProfile({ ...profile, business_city: e.target.value })} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                State
                <input style={inputStyle} value={profile.business_state} onChange={(e) => setProfile({ ...profile, business_state: e.target.value })} />
              </label>
            </div>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Location label
              <input style={inputStyle} value={profile.location} onChange={(e) => setProfile({ ...profile, location: e.target.value })} />
            </label>
            <div style={{ display: "grid", gap: 8 }}>
              <span style={{ fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>Upload profile image</span>
              {profile.profile_image ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <img
                    src={mediaUrl(profile.profile_image)}
                    alt="Current profile"
                    style={{
                      width: 96,
                      height: 96,
                      objectFit: "cover",
                      borderRadius: theme.radius.sm,
                      border: `1px solid ${theme.colors.border}`,
                    }}
                  />
                  <span style={{ fontSize: 12, color: theme.colors.muted }}>Current image</span>
                </div>
              ) : null}
              <label
                style={{
                  display: "inline-flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: 12,
                  color: theme.colors.muted,
                  fontWeight: 800,
                  cursor: profileImageBusy ? "wait" : "pointer",
                }}
              >
                <span>Choose file</span>
                <input
                  type="file"
                  accept={BRANDING_ACCEPT}
                  disabled={profileImageBusy}
                  style={{ maxWidth: "100%", fontSize: 13, color: theme.colors.text }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    setStatus("");
                    setProfileImageBusy(true);
                    try {
                      const url = await uploadBrandingFile(f);
                      const merged = { ...profile, profile_image: url };
                      setProfile(merged);
                      await apiPut(`/api/barber/profile${scopeQuery}`, merged, authHeaders());
                      setStatus("Profile image saved.");
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : "Upload failed");
                    } finally {
                      setProfileImageBusy(false);
                    }
                  }}
                />
              </label>
              {profileImageBusy ? (
                <span style={{ fontSize: 12, color: theme.colors.muted }} role="status">
                  Uploading…
                </span>
              ) : null}
              <span style={{ fontSize: 11, color: theme.colors.muted }}>JPEG, PNG, GIF, WebP, or AVIF · max 5MB</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <span style={{ fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>Upload logo</span>
              {profile.logo ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <img
                    src={mediaUrl(profile.logo)}
                    alt="Current logo"
                    style={{
                      maxWidth: 160,
                      maxHeight: 80,
                      objectFit: "contain",
                      borderRadius: theme.radius.sm,
                      border: `1px solid ${theme.colors.border}`,
                      background: "rgba(255,255,255,0.04)",
                    }}
                  />
                  <span style={{ fontSize: 12, color: theme.colors.muted }}>Current logo</span>
                </div>
              ) : null}
              <label
                style={{
                  display: "inline-flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: 12,
                  color: theme.colors.muted,
                  fontWeight: 800,
                  cursor: logoBusy ? "wait" : "pointer",
                }}
              >
                <span>Choose file</span>
                <input
                  type="file"
                  accept={BRANDING_ACCEPT}
                  disabled={logoBusy}
                  style={{ maxWidth: "100%", fontSize: 13, color: theme.colors.text }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    setStatus("");
                    setLogoBusy(true);
                    try {
                      const url = await uploadBrandingFile(f);
                      const merged = { ...profile, logo: url };
                      setProfile(merged);
                      await apiPut(`/api/barber/profile${scopeQuery}`, merged, authHeaders());
                      setStatus("Logo saved.");
                    } catch (err) {
                      setStatus(err instanceof Error ? err.message : "Upload failed");
                    } finally {
                      setLogoBusy(false);
                    }
                  }}
                />
              </label>
              {logoBusy ? (
                <span style={{ fontSize: 12, color: theme.colors.muted }} role="status">
                  Uploading…
                </span>
              ) : null}
              <span style={{ fontSize: 11, color: theme.colors.muted }}>JPEG, PNG, GIF, WebP, or AVIF · max 5MB</span>
            </div>
            <Button variant="indigo" type="button" onClick={saveProfile}>
              Save profile
            </Button>
          </div>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${theme.colors.border}` }}>
            <CardTitle>IFCDC account</CardTitle>
            <p style={{ fontSize: 13, color: theme.colors.muted, marginTop: 8, lineHeight: 1.5 }}>
              This is your shop profile for customers. To permanently delete your IFCDC sign-in and
              personal account, use the account deletion page.
            </p>
            <Link
              to="/profile/delete-account"
              className="ifcdc-delete-account__nav-btn"
              style={{ display: "inline-block", marginTop: 12 }}
            >
              Delete account permanently
            </Link>
          </div>
        </Card>
      ) : null}

      {tab === "services" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Services</CardTitle>
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {services.map((s) => {
              const photos = Array.isArray(s.gallery_photos) ? s.gallery_photos : [];
              const cover = getServiceCardImageUrl(s.image_url || s.cover_image_url);
              return (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    padding: 10,
                    border: `1px solid ${theme.colors.border}`,
                    borderRadius: theme.radius.sm,
                    background: theme.colors.subtle,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          width: 72,
                          height: 72,
                          borderRadius: theme.radius.sm,
                          overflow: "hidden",
                          border: `1px solid ${theme.colors.border}`,
                          background: "rgba(0,0,0,0.35)",
                          flexShrink: 0,
                        }}
                      >
                        <img
                          src={cover}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900, color: theme.colors.text }}>{s.name}</div>
                        <div style={{ fontSize: 13, color: theme.colors.muted }}>
                          ${Number(s.price).toFixed(2)} · {s.duration_minutes} min · {s.is_active ? "active" : "hidden"}
                          {photos.length ? ` · ${photos.length} photo${photos.length === 1 ? "" : "s"}` : ""}
                        </div>
                        <label
                          style={{
                            display: "inline-block",
                            marginTop: 6,
                            fontSize: 12,
                            color: theme.colors.muted,
                            cursor: svcImageBusy ? "wait" : "pointer",
                          }}
                        >
                          Add photos
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={svcImageBusy}
                            style={{ display: "block", marginTop: 4, maxWidth: "100%" }}
                            onChange={(e) => {
                              const fl = e.target.files;
                              e.target.value = "";
                              if (fl?.length) void uploadServicePhotoFiles(s.id, fl);
                            }}
                          />
                        </label>
                      </div>
                    </div>
                    <Button variant="indigo" type="button" onClick={() => removeService(s.id)}>
                      Delete service
                    </Button>
                  </div>
                  {photos.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {photos.map((p, idx) => (
                        <div
                          key={p.id}
                          style={{
                            width: 88,
                            border: `1px solid ${p.is_primary ? theme.colors.indigoBorder : theme.colors.border}`,
                            borderRadius: theme.radius.sm,
                            overflow: "hidden",
                            background: "rgba(0,0,0,0.35)",
                          }}
                        >
                          <img
                            src={getServiceCardImageUrl(p.image_url)}
                            alt=""
                            style={{ width: "100%", height: 72, objectFit: "cover", display: "block" }}
                          />
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 4 }}>
                            {p.is_primary ? (
                              <span style={{ fontSize: 10, color: theme.colors.indigo, fontWeight: 800 }}>Primary</span>
                            ) : (
                              <button
                                type="button"
                                disabled={svcImageBusy}
                                style={{ fontSize: 10, padding: 2, cursor: "pointer" }}
                                onClick={() => void makeServicePhotoPrimary(s.id, p.id)}
                              >
                                Set primary
                              </button>
                            )}
                            <div style={{ display: "flex", gap: 2 }}>
                              <button
                                type="button"
                                disabled={svcImageBusy || idx === 0}
                                style={{ flex: 1, fontSize: 10, padding: 2, cursor: "pointer" }}
                                onClick={() => void moveServicePhoto(s.id, photos, idx, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                disabled={svcImageBusy || idx === photos.length - 1}
                                style={{ flex: 1, fontSize: 10, padding: 2, cursor: "pointer" }}
                                onClick={() => void moveServicePhoto(s.id, photos, idx, 1)}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                disabled={svcImageBusy}
                                style={{ flex: 1, fontSize: 10, padding: 2, cursor: "pointer", color: "#f87171" }}
                                onClick={() => void removeServicePhoto(s.id, p.id)}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!services.length ? <div style={{ color: theme.colors.muted, fontSize: 13 }}>No services yet.</div> : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 120px auto", gap: 8, alignItems: "end" }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                New name
                <input style={inputStyle} value={svcDraft.name} onChange={(e) => setSvcDraft({ ...svcDraft, name: e.target.value })} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                Price
                <input style={inputStyle} value={svcDraft.price} onChange={(e) => setSvcDraft({ ...svcDraft, price: e.target.value })} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                Min
                <input
                  style={inputStyle}
                  value={svcDraft.duration_minutes}
                  onChange={(e) => setSvcDraft({ ...svcDraft, duration_minutes: e.target.value })}
                />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                Photo (optional)
                <input
                  type="file"
                  accept="image/*"
                  disabled={svcImageBusy}
                  onChange={(e) => setSvcImageFile(e.target.files?.[0] || null)}
                />
              </label>
              <Button variant="indigo" type="button" onClick={addService} disabled={svcImageBusy}>
                {svcImageBusy ? "Saving…" : "Add"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === "schedule" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Weekly schedule</CardTitle>
          <p style={{ fontSize: 13, color: theme.colors.muted, marginTop: 8 }}>
            Times use 24h <code>HH:MM</code>. Bookings outside these windows are blocked once you save.
          </p>
          <div style={{ marginTop: 12 }}>{[0, 1, 2, 3, 4, 5, 6].map(renderDayRow)}</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="indigo" type="button" onClick={saveAvailability}>
              Save schedule
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "payments" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Payments</CardTitle>
          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            <div
              style={{
                padding: 12,
                borderRadius: theme.radius.sm,
                border: `1px solid ${theme.colors.border}`,
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div style={{ fontWeight: 900, color: theme.colors.text, marginBottom: 8 }}>Subscription plan (MVP)</div>
              <p style={{ fontSize: 13, color: theme.colors.muted, marginBottom: 12 }}>
                Tier controls AURA and booking deposits. Checkout integration is coming; monthly price is optional
                until billing is connected.
              </p>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
                Tier
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={settings.subscription_tier}
                  onChange={(e) => {
                    const subscription_tier = e.target.value;
                    setSettings({
                      ...settings,
                      subscription_tier,
                      subscription_monthly_price: subscription_tier === "free" ? "" : settings.subscription_monthly_price,
                    });
                  }}
                >
                  <option value="free">Free — AURA and deposits off</option>
                  <option value="pro">Pro — $9.99–$19.99/mo (full features)</option>
                  <option value="elite">Elite — $29.99–$49.99/mo (full features)</option>
                </select>
              </label>
              {settings.subscription_tier !== "free" ? (
                <label
                  style={{
                    display: "grid",
                    gap: 6,
                    fontSize: 12,
                    color: theme.colors.muted,
                    fontWeight: 800,
                    marginTop: 10,
                  }}
                >
                  Planned monthly price (USD, optional)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    style={inputStyle}
                    placeholder={settings.subscription_tier === "elite" ? "29.99 – 49.99" : "9.99 – 19.99"}
                    value={settings.subscription_monthly_price}
                    onChange={(e) => setSettings({ ...settings, subscription_monthly_price: e.target.value })}
                  />
                </label>
              ) : null}
              <label
                style={{
                  display: "grid",
                  gap: 6,
                  fontSize: 12,
                  color: theme.colors.muted,
                  fontWeight: 800,
                  marginTop: 10,
                }}
              >
                Billing provider (reserved)
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={settings.billing_provider}
                  onChange={(e) => setSettings({ ...settings, billing_provider: e.target.value })}
                >
                  <option value="none">None yet</option>
                  <option value="stripe">Stripe (future)</option>
                  <option value="paypal">PayPal (future)</option>
                </select>
              </label>
              <label
                style={{
                  display: "grid",
                  gap: 6,
                  fontSize: 12,
                  color: theme.colors.muted,
                  fontWeight: 800,
                  marginTop: 10,
                }}
              >
                External subscription id (reserved)
                <input
                  style={inputStyle}
                  placeholder="Set automatically after checkout"
                  value={settings.billing_subscription_id}
                  onChange={(e) => setSettings({ ...settings, billing_subscription_id: e.target.value })}
                />
              </label>
            </div>
            <p style={{ fontSize: 13, color: theme.colors.muted }}>
              Customers pay the full service price plus the $0.99 IFCDC platform fee at checkout. Partial payments and
              deposits are not offered.
            </p>
            <Button variant="indigo" type="button" onClick={saveSettings}>
              Save payment settings
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "media" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Portfolio</CardTitle>
          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            {media.map((im) => (
              <div
                key={im.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  padding: 10,
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: theme.radius.sm,
                }}
              >
                <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
                  <img
                    src={mediaUrl(im.image_url)}
                    alt=""
                    style={{
                      width: 88,
                      height: 88,
                      objectFit: "cover",
                      borderRadius: theme.radius.sm,
                      border: `1px solid ${theme.colors.border}`,
                      flexShrink: 0,
                    }}
                  />
                  {im.caption ? (
                    <div style={{ fontSize: 13, color: theme.colors.text }}>{im.caption}</div>
                  ) : (
                    <div style={{ fontSize: 12, color: theme.colors.muted }}>Portfolio image</div>
                  )}
                </div>
                <Button variant="indigo" type="button" onClick={() => removeMedia(im.id)}>
                  Remove
                </Button>
              </div>
            ))}
            {!media.length ? <div style={{ color: theme.colors.muted, fontSize: 13 }}>No portfolio images yet.</div> : null}
            <input type="file" accept="image/*" onChange={(e) => setMediaFile(e.target.files?.[0] || null)} />
            <Button variant="indigo" type="button" onClick={uploadMedia}>
              Upload image
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "aura" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>AI (AURA)</CardTitle>
          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            {settings.subscription_tier === "free" ? (
              <p style={{ fontSize: 13, color: theme.colors.muted }}>
                AURA is disabled on the Free plan. Your preferences are saved for when you move to Pro or Elite under
                Payments → Subscription plan.
              </p>
            ) : null}
            <label style={{ display: "flex", alignItems: "center", gap: 10, color: theme.colors.text, fontWeight: 800 }}>
              <input
                type="checkbox"
                disabled={settings.subscription_tier === "free"}
                checked={settings.aura_enabled}
                onChange={(e) => setSettings({ ...settings, aura_enabled: e.target.checked })}
              />
              AURA enabled for this shop
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Voice (Amazon Polly id)
              <input
                style={inputStyle}
                disabled={settings.subscription_tier === "free"}
                value={settings.aura_voice_type}
                onChange={(e) => setSettings({ ...settings, aura_voice_type: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Theme accent (hex)
              <input
                style={inputStyle}
                value={settings.theme_color}
                onChange={(e) => setSettings({ ...settings, theme_color: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: theme.colors.muted, fontWeight: 800 }}>
              Language (AURA + booking emails)
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={settings.language === "es" ? "es" : "en"}
                onChange={(e) => setSettings({ ...settings, language: e.target.value })}
              >
                <option value="en">English</option>
                <option value="es">Spanish</option>
              </select>
            </label>
            <Button variant="indigo" type="button" onClick={saveSettings}>
              Save AURA settings
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "clients" ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Clients</CardTitle>
          <p style={{ fontSize: 13, color: theme.colors.muted, marginTop: 8 }}>Simple CRM list for your chair.</p>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {clients.map((c) => (
              <div
                key={c.id}
                style={{
                  fontSize: 13,
                  color: theme.colors.text,
                  padding: 8,
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: 8,
                }}
              >
                <strong>{c.name}</strong> {c.phone ? `· ${c.phone}` : ""}
                {c.notes ? <div style={{ color: theme.colors.muted, marginTop: 4 }}>{c.notes}</div> : null}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
            <input
              style={inputStyle}
              placeholder="Name"
              value={clientDraft.name}
              onChange={(e) => setClientDraft({ ...clientDraft, name: e.target.value })}
            />
            <input
              style={inputStyle}
              placeholder="Phone"
              value={clientDraft.phone}
              onChange={(e) => setClientDraft({ ...clientDraft, phone: e.target.value })}
            />
            <input
              style={inputStyle}
              placeholder="Notes"
              value={clientDraft.notes}
              onChange={(e) => setClientDraft({ ...clientDraft, notes: e.target.value })}
            />
            <Button variant="indigo" type="button" onClick={addClient}>
              Add
            </Button>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
