import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getApiOrigin } from "../services/api.js";
import { getAdminAuthHeaders } from "../lib/authHeaders.js";

async function mtFetch(path, { method = "GET", body } = {}) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...getAdminAuthHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

const emptyForm = () => ({
  mode: "existing",
  userId: "",
  searchQ: "",
  email: "",
  name: "",
  phone: "",
  createIfMissing: true,
  role: "shop_manager",
  shopIds: [],
  locationIds: [],
  fullAccess: false,
  permissions: {},
  notes: "",
});

export default function AdminManagementTeam() {
  const [managers, setManagers] = useState([]);
  const [meta, setMeta] = useState({ roles: [], permissions: [] });
  const [shops, setShops] = useState([]);
  const [locations, setLocations] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [candidates, setCandidates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, metaRes, shopsRes, act] = await Promise.all([
        mtFetch("/api/admin/management-team"),
        mtFetch("/api/admin/management-team/meta"),
        mtFetch("/api/admin/management-team/shops"),
        mtFetch("/api/admin/management-team/activity?limit=50"),
      ]);
      setManagers(list.managers || []);
      setMeta(metaRes);
      setShops(shopsRes.shops || []);
      setActivity(act.logs || []);
    } catch (e) {
      setError(e?.message || "Failed to load Management Team");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!form.shopIds.length) {
      setLocations([]);
      return;
    }
    const ids = form.shopIds.join(",");
    mtFetch(`/api/admin/management-team/locations?businessIds=${encodeURIComponent(ids)}`)
      .then((r) => setLocations(r.locations || []))
      .catch(() => setLocations([]));
  }, [form.shopIds]);

  const permissionKeys = useMemo(() => meta.permissions || [], [meta.permissions]);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm());
    setCandidates([]);
    setShowForm(true);
    setStatusMsg(null);
  };

  const openEdit = (m) => {
    setEditingId(m.id);
    const perms = { ...(m.permissions || {}) };
    setForm({
      mode: "existing",
      userId: m.userId,
      searchQ: m.user?.email || "",
      email: m.user?.email || "",
      name: m.user?.name || "",
      phone: m.user?.phone || "",
      createIfMissing: false,
      role: m.role,
      shopIds: (m.shops || []).map((s) => s.businessId),
      locationIds: (m.locations || []).map((l) => l.locationId),
      fullAccess: m.fullAccess === true,
      permissions: perms,
      notes: m.notes || "",
    });
    setShowForm(true);
    setStatusMsg(null);
  };

  const searchUsers = async () => {
    if (!form.searchQ.trim()) return;
    try {
      const r = await mtFetch(
        `/api/admin/management-team/users/search?q=${encodeURIComponent(form.searchQ.trim())}`,
      );
      setCandidates(r.users || []);
    } catch (e) {
      setStatusMsg(e.message);
    }
  };

  const toggleShop = (businessId) => {
    setForm((f) => {
      const has = f.shopIds.includes(businessId);
      const shopIds = has ? f.shopIds.filter((id) => id !== businessId) : [...f.shopIds, businessId];
      return { ...f, shopIds, locationIds: f.locationIds };
    });
  };

  const toggleLocation = (locationId) => {
    setForm((f) => {
      const has = f.locationIds.includes(locationId);
      return {
        ...f,
        locationIds: has
          ? f.locationIds.filter((id) => id !== locationId)
          : [...f.locationIds, locationId],
      };
    });
  };

  const togglePerm = (key) => {
    if (key === "full_manager_access") {
      setForm((f) => ({ ...f, fullAccess: !f.fullAccess }));
      return;
    }
    setForm((f) => ({
      ...f,
      permissions: { ...f.permissions, [key]: !f.permissions[key] },
    }));
  };

  const save = async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const payload = {
        role: form.role,
        shopIds: form.shopIds,
        locationIds: form.locationIds,
        fullAccess: form.fullAccess,
        permissions: {
          ...form.permissions,
          full_manager_access: form.fullAccess,
        },
        notes: form.notes || null,
      };
      if (editingId) {
        await mtFetch(`/api/admin/management-team/${editingId}`, { method: "PATCH", body: payload });
        setStatusMsg("Manager updated.");
      } else {
        const body =
          form.mode === "existing" && form.userId
            ? { ...payload, userId: form.userId }
            : {
                ...payload,
                email: form.email,
                name: form.name,
                phone: form.phone || null,
                createIfMissing: form.createIfMissing,
              };
        const r = await mtFetch("/api/admin/management-team", { method: "POST", body });
        setStatusMsg(
          r.temporaryPassword
            ? `Manager created. Temporary password: ${r.temporaryPassword}`
            : "Manager assigned.",
        );
      }
      setShowForm(false);
      await loadAll();
    } catch (e) {
      setStatusMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (id, action) => {
    if (action === "remove" && !window.confirm("Remove management access for this person?")) return;
    try {
      await mtFetch(`/api/admin/management-team/${id}/${action}`, { method: "POST", body: {} });
      await loadAll();
    } catch (e) {
      setStatusMsg(e.message);
    }
  };

  return (
    <div style={page}>
      <div style={wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={h1}>Management Team</h1>
            <p style={muted}>
              Assign multiple managers with shop/location scope. Super Admin retains full platform
              control.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <Link to="/admin" style={btnOutline}>
              ← Admin
            </Link>
            <button type="button" style={btnGold} onClick={openAdd}>
              + Add Manager
            </button>
          </div>
        </div>

        {error ? <p style={{ color: "#fecaca" }}>{error}</p> : null}
        {statusMsg ? <p style={{ color: "#86efac" }}>{statusMsg}</p> : null}
        {loading ? <p style={muted}>Loading…</p> : null}

        {!loading ? (
          <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
            {managers.length === 0 ? (
              <p style={muted}>No managers assigned yet.</p>
            ) : (
              managers.map((m) => (
                <div key={m.id} style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ color: "#f5f5f5", fontSize: 18 }}>
                        {m.user?.name || "Unnamed"}
                      </strong>
                      <div style={muted}>
                        {m.user?.email || "—"}
                        {m.user?.phone ? ` · ${m.user.phone}` : ""}
                      </div>
                      <div style={{ marginTop: 6, color: "#d4af37" }}>
                        {m.roleLabel} ·{" "}
                        <span style={{ color: m.status === "active" ? "#86efac" : "#fbbf24" }}>
                          {String(m.status || "").toUpperCase()}
                        </span>
                      </div>
                      <div style={{ ...muted, marginTop: 8 }}>
                        Shops:{" "}
                        {(m.shops || []).map((s) => s.name).join(", ") || "—"}
                      </div>
                      <div style={muted}>
                        Locations:{" "}
                        {(m.locations || []).map((l) => l.name).join(", ") || "—"}
                      </div>
                      <div style={{ ...muted, marginTop: 6 }}>
                        Permissions:{" "}
                        {m.fullAccess
                          ? "Full Manager Access (scoped)"
                          : Object.entries(m.permissions || {})
                              .filter(([k, v]) => v && k !== "full_manager_access")
                              .map(([k]) => k)
                              .join(", ") || "None"}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <button type="button" style={btnOutline} onClick={() => openEdit(m)}>
                        Edit
                      </button>
                      {m.status === "active" ? (
                        <button type="button" style={btnOutline} onClick={() => act(m.id, "suspend")}>
                          Suspend
                        </button>
                      ) : m.status === "suspended" ? (
                        <button
                          type="button"
                          style={btnOutline}
                          onClick={() => act(m.id, "reactivate")}
                        >
                          Reactivate
                        </button>
                      ) : null}
                      {m.status !== "removed" ? (
                        <button type="button" style={btnDanger} onClick={() => act(m.id, "remove")}>
                          Remove Management Access
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {showForm ? (
          <div style={{ ...card, marginTop: 24, borderColor: "#d4af37" }}>
            <h2 style={{ color: "#d4af37", marginTop: 0 }}>
              {editingId ? "Edit Manager" : "Add Manager"}
            </h2>

            {!editingId ? (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button
                    type="button"
                    style={form.mode === "existing" ? btnGold : btnOutline}
                    onClick={() => setForm((f) => ({ ...f, mode: "existing" }))}
                  >
                    Existing user
                  </button>
                  <button
                    type="button"
                    style={form.mode === "invite" ? btnGold : btnOutline}
                    onClick={() => setForm((f) => ({ ...f, mode: "invite" }))}
                  >
                    Invite / create
                  </button>
                </div>
                {form.mode === "existing" ? (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        style={input}
                        placeholder="Search name, email, or phone"
                        value={form.searchQ}
                        onChange={(e) => setForm((f) => ({ ...f, searchQ: e.target.value }))}
                      />
                      <button type="button" style={btnOutline} onClick={searchUsers}>
                        Search
                      </button>
                    </div>
                    {candidates.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        style={{
                          ...btnOutline,
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          marginTop: 8,
                          background: form.userId === u.id ? "#333" : "#111",
                        }}
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            userId: u.id,
                            email: u.email,
                            name: u.name || "",
                          }))
                        }
                      >
                        {u.name || "—"} · {u.email} ({u.role})
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
                    <input
                      style={input}
                      placeholder="Email"
                      value={form.email}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    />
                    <input
                      style={input}
                      placeholder="Name"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    />
                    <input
                      style={input}
                      placeholder="Phone (optional)"
                      value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                    />
                  </div>
                )}
              </>
            ) : null}

            <label style={label}>Management role</label>
            <select
              style={input}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {(meta.roles || []).map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>

            <label style={label}>Assigned shop(s)</label>
            <div style={chipGrid}>
              {shops.map((s) => (
                <label key={s.businessId} style={chip}>
                  <input
                    type="checkbox"
                    checked={form.shopIds.includes(s.businessId)}
                    onChange={() => toggleShop(s.businessId)}
                  />
                  {s.name}
                </label>
              ))}
            </div>

            <label style={label}>Assigned location(s)</label>
            <div style={chipGrid}>
              {locations.length === 0 ? (
                <span style={muted}>Select shop(s) to load locations.</span>
              ) : (
                locations.map((l) => (
                  <label key={l.locationId} style={chip}>
                    <input
                      type="checkbox"
                      checked={form.locationIds.includes(l.locationId)}
                      onChange={() => toggleLocation(l.locationId)}
                    />
                    {l.name}
                    {l.city ? ` (${l.city})` : ""}
                  </label>
                ))
              )}
            </div>

            <label style={label}>Permissions</label>
            <div style={chipGrid}>
              {permissionKeys.map((p) => (
                <label key={p.key} style={chip}>
                  <input
                    type="checkbox"
                    checked={
                      p.key === "full_manager_access"
                        ? form.fullAccess
                        : form.fullAccess || form.permissions[p.key] === true
                    }
                    disabled={form.fullAccess && p.key !== "full_manager_access"}
                    onChange={() => togglePerm(p.key)}
                  />
                  {p.label}
                </label>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button type="button" style={btnGold} disabled={saving} onClick={save}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" style={btnOutline} onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <h2 style={{ ...h1, fontSize: 22, marginTop: 36 }}>Activity log</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {activity.length === 0 ? (
            <p style={muted}>No management activity yet.</p>
          ) : (
            activity.map((row) => (
              <div key={row.id} style={{ ...card, padding: 12 }}>
                <div style={{ color: "#f5f5f5" }}>{row.action}</div>
                <div style={muted}>
                  {row.actor_email || "—"} · {row.created_at}
                  {row.business_id ? ` · shop ${row.business_id}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const page = { minHeight: "100vh", background: "#0a0a0a", color: "#eee", padding: "24px 16px" };
const wrap = { maxWidth: 960, margin: "0 auto" };
const h1 = { color: "#d4af37", margin: "0 0 8px" };
const muted = { color: "#9ca3af", fontSize: 14 };
const card = {
  background: "#141414",
  border: "1px solid #333",
  borderRadius: 12,
  padding: 16,
};
const btnGold = {
  background: "#d4af37",
  color: "#111",
  border: "none",
  borderRadius: 8,
  padding: "10px 14px",
  fontWeight: 700,
  cursor: "pointer",
};
const btnOutline = {
  background: "transparent",
  color: "#d4af37",
  border: "1px solid #d4af37",
  borderRadius: 8,
  padding: "10px 14px",
  cursor: "pointer",
};
const btnDanger = {
  ...btnOutline,
  color: "#fecaca",
  borderColor: "#fecaca",
};
const input = {
  width: "100%",
  background: "#0a0a0a",
  color: "#eee",
  border: "1px solid #444",
  borderRadius: 8,
  padding: "10px 12px",
  marginBottom: 8,
};
const label = { display: "block", color: "#d4af37", margin: "12px 0 6px", fontSize: 13 };
const chipGrid = { display: "flex", flexWrap: "wrap", gap: 8 };
const chip = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "#1a1a1a",
  border: "1px solid #333",
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 13,
};
