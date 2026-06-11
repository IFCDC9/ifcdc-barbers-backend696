import React from "react";
import {
  getBarbers,
  getStylesAll,
  createStyle,
  createStylesBatch,
  updateStyle,
  deleteStyle,
  reorderStyleGallery,
  replaceStyleImage,
} from "../services/api.js";
import StyleCoverImage from "./StyleCoverImage.jsx";
import { UPLOAD_ACCEPT, validateImageUploadFile } from "../lib/imageUploadValidation.js";

const CATEGORIES = ["fades", "tapers", "waves", "braids", "beard work", "kids cuts", "designs", "other"];
const GALLERY_PHOTO_LIMIT = 100;

function styleSortKey(s) {
  const src = String(s?.source || "");
  if (src === "barber_style_gallery") {
    return [0, Number(s.sort_order) || 0, String(s.id)];
  }
  return [1, Number(s.service_id) || 0, String(s.id)];
}

function compareStyles(a, b) {
  const ka = styleSortKey(a);
  const kb = styleSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

export default function StylesManagement({ lockedBarberId = null, onChanged }) {
  const [barbers, setBarbers] = React.useState([]);
  const [styles, setStyles] = React.useState([]);
  const [selectedBarberId, setSelectedBarberId] = React.useState(lockedBarberId || "");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [category, setCategory] = React.useState("other");
  const [price, setPrice] = React.useState("35");
  const [files, setFiles] = React.useState([]);
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

  const barberId = lockedBarberId != null ? String(lockedBarberId) : String(selectedBarberId || "").trim();

  const stylesForSelected = React.useMemo(() => {
    if (!barberId) return [];
    return (Array.isArray(styles) ? styles : [])
      .filter((s) => String(s.barber_id) === barberId)
      .sort(compareStyles);
  }, [styles, barberId]);

  const galleryCount = React.useMemo(
    () => stylesForSelected.filter((s) => s.source === "barber_style_gallery").length,
    [stylesForSelected],
  );

  const submit = async () => {
    setMsg("");
    if (!barberId) return setMsg("Select a barber.");
    if (!title.trim()) return setMsg("Title required.");
    if (!files.length) return setMsg("Select at least one photo.");

    for (const f of files) {
      const fileErr = validateImageUploadFile(f);
      if (fileErr) return setMsg(fileErr);
    }

    setBusy(true);
    try {
      if (files.length === 1) {
        await createStyle({ barberId, title, description, category, file: files[0], price: Number(price) });
      } else {
        await createStylesBatch({ barberId, title, description, category, files, price: Number(price) });
      }
      setTitle("");
      setDescription("");
      setCategory("other");
      setPrice("35");
      setFiles([]);
      await load();
      onChanged?.();
      setMsg(files.length > 1 ? `Saved ${files.length} photos.` : "Saved.");
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

  const moveStyle = async (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= stylesForSelected.length) return;
    const reordered = [...stylesForSelected];
    const [item] = reordered.splice(index, 1);
    reordered.splice(nextIndex, 0, item);
    setBusy(true);
    setMsg("");
    try {
      await reorderStyleGallery({
        barberId,
        orderedIds: reordered.map((s) => s.id),
      });
      await load();
      onChanged?.();
      setMsg("Order updated.");
    } catch (e) {
      setMsg(e?.message || "Reorder failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-panel" style={{ padding: 14, marginTop: 14 }}>
      <h2 style={{ margin: 0, color: "rgba(245,217,122,0.95)", letterSpacing: "0.08em" }}>Styles Management</h2>
      <p style={{ margin: "8px 0 12px", color: "rgba(255,255,255,0.68)" }}>
        Upload haircut photos for your gallery — up to {GALLERY_PHOTO_LIMIT} per barber. Select multiple files at once.
        Use the arrows on each card to set which photo appears first on the website and app.
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

      {barberId ? (
        <p style={{ margin: "0 0 10px", color: "rgba(255,255,255,0.55)", fontSize: 13 }}>
          Gallery photos: {galleryCount} / {GALLERY_PHOTO_LIMIT}
        </p>
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
            multiple
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              const valid = [];
              for (const next of picked) {
                const err = validateImageUploadFile(next);
                if (err) {
                  setMsg(err);
                  e.target.value = "";
                  setFiles([]);
                  return;
                }
                valid.push(next);
              }
              setFiles(valid);
              if (valid.length) setMsg(`${valid.length} photo(s) selected.`);
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
            {busy ? "Saving…" : files.length > 1 ? `Upload ${files.length} photos` : "Save"}
          </button>
        </div>
        {files.length ? (
          <p style={{ margin: 0, color: "rgba(255,255,255,0.6)", fontSize: 13 }}>
            Selected: {files.map((f) => f.name).join(", ")}
          </p>
        ) : null}
      </div>

      {!barberId ? (
        <div style={{ color: "rgba(255,255,255,0.6)" }}>Select a barber to see their gallery.</div>
      ) : !stylesForSelected.length ? (
        <div style={{ color: "rgba(255,255,255,0.7)" }}>No styles uploaded yet.</div>
      ) : (
        <div className="ifcdc-style-grid">
          {stylesForSelected.map((s, index) => (
            <div key={s.id} className="ifcdc-style-card">
              <div className="ifcdc-cover-media" style={{ aspectRatio: "4 / 5", position: "relative" }}>
                <StyleCoverImage
                  bare
                  styleId={s.id}
                  barberId={s.barber_id}
                  imageUrl={s.image_url}
                  alt={s.title || ""}
                  logContext="styles-management"
                />
                {index === 0 ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 8,
                      left: 8,
                      background: "rgba(212,175,55,0.9)",
                      color: "#111",
                      fontSize: 11,
                      fontWeight: 900,
                      padding: "4px 8px",
                      borderRadius: 999,
                    }}
                  >
                    Cover
                  </span>
                ) : null}
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
                      <button type="button" onClick={() => void moveStyle(index, -1)} disabled={busy || index === 0} title="Move earlier">
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => void moveStyle(index, 1)}
                        disabled={busy || index === stylesForSelected.length - 1}
                        title="Move later"
                      >
                        ↓
                      </button>
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
