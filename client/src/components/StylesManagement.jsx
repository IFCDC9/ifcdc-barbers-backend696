import React from "react";
import { getBarbers, getStylesAll, createStyle, updateStyle, deleteStyle, mediaUrl, replaceStyleImage } from "../services/api.js";
import StyleCoverImage from "./StyleCoverImage.jsx";
import { UPLOAD_ACCEPT, validateImageUploadFile } from "../lib/imageUploadValidation.js";

const CATEGORIES = ["fades", "tapers", "waves", "braids", "beard work", "kids cuts", "designs", "other"];

export default function StylesManagement({ lockedBarberId = null, onChanged }) {
  const [barbers, setBarbers] = React.useState([]);
  const [styles, setStyles] = React.useState([]);
  const [selectedBarberId, setSelectedBarberId] = React.useState(lockedBarberId || "");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [category, setCategory] = React.useState("other");
  const [price, setPrice] = React.useState("35");
  const [file, setFile] = React.useState(null);
  const [msg, setMsg] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState(null);
  const [edit, setEdit] = React.useState({ title: "", description: "", category: "other", price: "35" });
  const [editImageFile, setEditImageFile] = React.useState(null);

  const load = React.useCallback(async () => {
    const [b, s] = await Promise.all([getBarbers().catch(() => []), getStylesAll().catch(() => [])]);
    setBarbers(Array.isArray(b) ? b : []);
    setStyles(Array.isArray(s) ? s : []);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const stylesForSelected = React.useMemo(() => {
    const id = selectedBarberId ? String(selectedBarberId).trim() : "";
    if (!id) return [];
    return (Array.isArray(styles) ? styles : []).filter((s) => String(s.barber_id) === id);
  }, [styles, selectedBarberId]);

  const submit = async () => {
    setMsg("");
    const barberId = lockedBarberId != null ? lockedBarberId : String(selectedBarberId || "").trim();
    if (!barberId) return setMsg("Select a barber.");
    if (!title.trim()) return setMsg("Title required.");
    const fileErr = validateImageUploadFile(file);
    if (fileErr) return setMsg(fileErr);

    setBusy(true);
    try {
      await createStyle({ barberId, title, description, category, file, price: Number(price) });
      setTitle("");
      setDescription("");
      setCategory("other");
      setPrice("35");
      setFile(null);
      await load();
      onChanged?.();
      setMsg("Saved.");
    } catch (e) {
      setMsg(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setEditImageFile(null);
    setEdit({
      title: String(s.title || ""),
      description: String(s.description || ""),
      category: String(s.category || "other"),
      price: String(s.price != null ? s.price : "35"),
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusy(true);
    setMsg("");
    try {
      if (editImageFile) {
        await replaceStyleImage(editingId, editImageFile);
      }
      await updateStyle(editingId, {
        title: edit.title,
        description: edit.description,
        category: edit.category,
        price: Number(edit.price),
      });
      setEditingId(null);
      setEditImageFile(null);
      await load();
      onChanged?.();
      setMsg("Updated.");
    } catch (e) {
      setMsg(e?.message || "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const togglePublish = async (s) => {
    const next = s.is_published === false;
    setBusy(true);
    setMsg("");
    try {
      await updateStyle(s.id, { is_published: next });
      await load();
      onChanged?.();
      setMsg(next ? "Style published to booking." : "Style unpublished.");
    } catch (e) {
      setMsg(e?.message || "Publish toggle failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this style photo?")) return;
    setBusy(true);
    setMsg("");
    try {
      await deleteStyle(id);
      await load();
      onChanged?.();
      setMsg("Deleted.");
    } catch (e) {
      setMsg(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-panel" style={{ padding: 14, marginTop: 14 }}>
      <h2 style={{ margin: 0, color: "rgba(245,217,122,0.95)", letterSpacing: "0.08em" }}>Styles Management</h2>
      <p style={{ margin: "8px 0 12px", color: "rgba(255,255,255,0.68)" }}>
        Upload haircut/style photos with title, description, and category. These display publicly on barber cards.
      </p>

      {msg ? <div style={{ marginBottom: 10, color: "rgba(245,217,122,0.95)", fontWeight: 800 }}>{msg}</div> : null}

      {!lockedBarberId ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <select
            value={selectedBarberId}
            onChange={(e) => setSelectedBarberId(e.target.value)}
            style={{ flex: "1 1 220px", padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.35)", color: "white" }}
          >
            <option value="">Select barber…</option>
            {barbers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 12 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Skin fade + lineup)"
          style={{ padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.35)", color: "white", border: "1px solid rgba(212,175,55,0.25)" }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description"
          rows={3}
          style={{ padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.35)", color: "white", border: "1px solid rgba(212,175,55,0.25)" }}
        />
        <input
          type="number"
          min="1"
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="Price USD"
          style={{ padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.35)", color: "white", border: "1px solid rgba(212,175,55,0.25)" }}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ flex: "1 1 220px", padding: 10, borderRadius: 10, background: "rgba(0,0,0,0.35)", color: "white" }}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="file"
            accept={UPLOAD_ACCEPT}
            onChange={(e) => {
              const next = e.target.files?.[0] || null;
              const err = validateImageUploadFile(next);
              if (err) {
                setMsg(err);
                e.target.value = "";
                setFile(null);
                return;
              }
              setFile(next);
            }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            style={{
              padding: "10px 14px",
              borderRadius: 999,
              border: "1px solid rgba(212,175,55,0.35)",
              background: "rgba(212,175,55,0.16)",
              color: "rgba(245,217,122,0.95)",
              fontWeight: 900,
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {!selectedBarberId && !lockedBarberId ? (
        <div style={{ color: "rgba(255,255,255,0.6)" }}>Select a barber to see their gallery.</div>
      ) : !stylesForSelected.length ? (
        <div style={{ color: "rgba(255,255,255,0.7)" }}>No styles uploaded yet.</div>
      ) : (
        <div className="ifcdc-style-grid">
          {stylesForSelected.map((s) => (
            <div key={s.id} className="ifcdc-style-card">
              <div className="ifcdc-cover-media" style={{ aspectRatio: "4 / 5" }}>
                <StyleCoverImage
                  bare
                  styleId={s.id}
                  barberId={s.barber_id}
                  imageUrl={s.image_url}
                  alt={s.title || ""}
                  logContext="styles-management"
                />
              </div>
              <div className="ifcdc-style-meta">
                {editingId === s.id ? (
                  <>
                    <input
                      value={edit.title}
                      onChange={(e) => setEdit((m) => ({ ...m, title: e.target.value }))}
                      style={{ width: "100%", padding: 8, borderRadius: 10, marginBottom: 8 }}
                    />
                    <textarea
                      value={edit.description}
                      onChange={(e) => setEdit((m) => ({ ...m, description: e.target.value }))}
                      rows={2}
                      style={{ width: "100%", padding: 8, borderRadius: 10, marginBottom: 8 }}
                    />
                    <select
                      value={edit.category}
                      onChange={(e) => setEdit((m) => ({ ...m, category: e.target.value }))}
                      style={{ width: "100%", padding: 8, borderRadius: 10, marginBottom: 8 }}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      value={edit.price}
                      onChange={(e) => setEdit((m) => ({ ...m, price: e.target.value }))}
                      placeholder="Price USD"
                      style={{ width: "100%", padding: 8, borderRadius: 10, marginBottom: 8 }}
                    />
                    <input
                      type="file"
                      accept={UPLOAD_ACCEPT}
                      onChange={(e) => {
                        const next = e.target.files?.[0] || null;
                        const err = validateImageUploadFile(next);
                        if (err) {
                          setMsg(err);
                          e.target.value = "";
                          setEditImageFile(null);
                          return;
                        }
                        setEditImageFile(next);
                      }}
                      style={{ width: "100%", marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => void saveEdit()} disabled={busy}>
                        Save
                      </button>
                      <button type="button" onClick={() => { setEditingId(null); setEditImageFile(null); }} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="ifcdc-style-title">{s.title}</p>
                    <p className="ifcdc-style-desc" style={{ fontWeight: 800 }}>
                      ${Number(s.price ?? 25).toFixed(2)}
                    </p>
                    {s.description ? <p className="ifcdc-style-desc">{s.description}</p> : null}
                    <div className="ifcdc-style-cat">{s.category || "other"}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => startEdit(s)} disabled={busy}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void togglePublish(s)}
                        disabled={busy}
                        title={s.is_published === false ? "Publish to booking" : "Unpublish from booking"}
                      >
                        {s.is_published === false ? "Publish" : "Unpublish"}
                      </button>
                      <button type="button" onClick={() => void remove(s.id)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

