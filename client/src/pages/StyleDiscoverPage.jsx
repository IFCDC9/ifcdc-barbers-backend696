import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { theme } from "../components/ui/theme.js";
import { getStoredUser } from "../lib/authHeaders.js";
import {
  deleteDiscoverPhoto,
  fetchDiscoverPhotos,
  fetchPortfolioCategories,
  hideDiscoverPhoto,
  patchDiscoverPhoto,
  replaceDiscoverPhotoImage,
  setDiscoverPhotoCover,
} from "../services/socialPortfolioApi.js";

function staffCanSeeEditMenus(user) {
  if (!user) return false;
  const role = String(user.role || "").toLowerCase();
  return (
    user.isSuperAdmin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "shop_owner" ||
    role === "barber"
  );
}

export default function StyleDiscoverPage() {
  const navigate = useNavigate();
  const user = getStoredUser();
  const showStaffChrome = staffCanSeeEditMenus(user);

  const [categories, setCategories] = React.useState([]);
  const [activeCategory, setActiveCategory] = React.useState("");
  const [photos, setPhotos] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [menuPhotoId, setMenuPhotoId] = React.useState("");
  const [editPhoto, setEditPhoto] = React.useState(null);
  const [busyId, setBusyId] = React.useState("");
  const fileInputRef = React.useRef(null);
  const replaceTargetRef = React.useRef(null);
  const stripRef = React.useRef(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchDiscoverPhotos({
        styleCategory: activeCategory || undefined,
        limit: 48,
      });
      setPhotos(Array.isArray(data?.photos) ? data.photos : []);
    } catch (e) {
      setError(e?.message || "Failed to load photos");
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [activeCategory]);

  React.useEffect(() => {
    void fetchPortfolioCategories()
      .then((data) => setCategories(Array.isArray(data?.categories) ? data.categories : []))
      .catch(() => setCategories([]));
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    const el = stripRef.current?.querySelector(`[data-cat="${activeCategory || "all"}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [activeCategory]);

  const runAction = async (photo, action) => {
    setMenuPhotoId("");
    setBusyId(photo.id);
    try {
      if (action === "edit") {
        setEditPhoto({
          id: photo.id,
          title: photo.title || photo.caption || photo.serviceName || "",
          caption: photo.caption || "",
          styleCategory: photo.styleCategory || "",
        });
      } else if (action === "replace") {
        replaceTargetRef.current = photo.id;
        fileInputRef.current?.click();
      } else if (action === "cover") {
        await setDiscoverPhotoCover(photo.id);
        await reload();
      } else if (action === "hide") {
        await hideDiscoverPhoto(photo.id);
        await reload();
      } else if (action === "delete") {
        if (!window.confirm("Permanently delete this photo? This cannot be undone.")) return;
        await deleteDiscoverPhoto(photo.id);
        await reload();
      } else if (action === "category") {
        setEditPhoto({
          id: photo.id,
          title: photo.title || photo.caption || "",
          caption: photo.caption || "",
          styleCategory: photo.styleCategory || "",
          focusCategory: true,
        });
      }
    } catch (e) {
      window.alert(e?.message || "Action failed");
    } finally {
      setBusyId("");
    }
  };

  const onReplaceFile = async (e) => {
    const file = e.target.files?.[0];
    const photoId = replaceTargetRef.current;
    e.target.value = "";
    if (!file || !photoId) return;
    setBusyId(photoId);
    try {
      await replaceDiscoverPhotoImage(photoId, file);
      await reload();
    } catch (err) {
      window.alert(err?.message || "Replace failed");
    } finally {
      setBusyId("");
      replaceTargetRef.current = null;
    }
  };

  const saveEdit = async () => {
    if (!editPhoto?.id) return;
    setBusyId(editPhoto.id);
    try {
      await patchDiscoverPhoto(editPhoto.id, {
        title: editPhoto.title,
        caption: editPhoto.caption,
        styleCategory: editPhoto.styleCategory || undefined,
      });
      setEditPhoto(null);
      await reload();
    } catch (e) {
      window.alert(e?.message || "Save failed");
    } finally {
      setBusyId("");
    }
  };

  const chipStyle = (active) => ({
    flex: "0 0 auto",
    whiteSpace: "nowrap",
    padding: "10px 16px",
    minHeight: 40,
    borderRadius: 999,
    border: `1px solid ${active ? theme.colors.accent : theme.colors.border}`,
    background: active ? theme.colors.indigoBg : "transparent",
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    lineHeight: 1.2,
  });

  return (
    <Page>
      <PageHeader
        title="Discover haircuts"
        subtitle="Browse real client results by style before you book"
        right={
          <Link to="/booking" style={{ color: theme.colors.text, fontWeight: 700 }}>
            Book
          </Link>
        }
      />

      <div
        ref={stripRef}
        className="ifcdc-discover-strip"
        style={{
          display: "flex",
          flexWrap: "nowrap",
          gap: 8,
          marginTop: 16,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: 6,
          scrollbarWidth: "thin",
        }}
      >
        <button
          type="button"
          data-cat="all"
          onClick={() => setActiveCategory("")}
          style={chipStyle(!activeCategory)}
        >
          All Styles
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            data-cat={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            style={chipStyle(activeCategory === cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onReplaceFile}
      />

      {loading ? <p style={{ marginTop: 16, color: theme.colors.muted }}>Loading…</p> : null}
      {error ? <p style={{ marginTop: 16, color: theme.colors.danger }}>{error}</p> : null}

      <div
        style={{
          display: "grid",
          gap: 12,
          marginTop: 16,
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        }}
      >
        {photos.map((photo) => {
          const canEdit = showStaffChrome && photo.canEdit === true;
          return (
            <Card
              key={photo.id}
              style={{ padding: 0, overflow: "hidden", position: "relative" }}
            >
              <button
                type="button"
                style={{
                  display: "block",
                  width: "100%",
                  padding: 0,
                  border: 0,
                  background: "transparent",
                  cursor: photo.barberSlug ? "pointer" : "default",
                  textAlign: "left",
                  color: "inherit",
                }}
                onClick={() => {
                  if (photo.barberSlug) navigate(`/p/${photo.barberSlug}`);
                }}
              >
                <img
                  src={photo.thumbnailUrl || photo.photoUrl}
                  alt={photo.caption || photo.barberName || "Haircut"}
                  style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }}
                />
                <div style={{ padding: 10, fontSize: 13 }}>
                  <strong>{photo.barberName || "Barber"}</strong>
                  {photo.styleCategory ? (
                    <div style={{ color: theme.colors.muted, marginTop: 4, textTransform: "capitalize" }}>
                      {String(photo.styleCategory).replace(/_/g, " ")}
                    </div>
                  ) : null}
                  {photo.likeCount ? (
                    <div style={{ color: theme.colors.muted, marginTop: 4 }}>♥ {photo.likeCount}</div>
                  ) : null}
                </div>
              </button>

              {canEdit ? (
                <div style={{ position: "absolute", top: 8, right: 8 }}>
                  <button
                    type="button"
                    aria-label="Photo actions"
                    disabled={busyId === photo.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuPhotoId((id) => (id === photo.id ? "" : photo.id));
                    }}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 999,
                      border: "1px solid rgba(255,255,255,0.25)",
                      background: "rgba(0,0,0,0.65)",
                      color: "#fff",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    ⋯
                  </button>
                  {menuPhotoId === photo.id ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 40,
                        right: 0,
                        minWidth: 170,
                        background: "#111",
                        border: `1px solid ${theme.colors.border}`,
                        borderRadius: 10,
                        zIndex: 5,
                        overflow: "hidden",
                      }}
                    >
                      {[
                        ["edit", "Edit Photo"],
                        ["replace", "Replace Photo"],
                        ["category", "Change Category"],
                        ["cover", "Set as Cover"],
                        ["hide", "Hide Photo"],
                        ["delete", "Delete Photo"],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void runAction(photo, key);
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "10px 12px",
                            border: 0,
                            background: "transparent",
                            color: key === "delete" ? "#f87171" : theme.colors.text,
                            cursor: "pointer",
                            fontSize: 13,
                            fontWeight: 600,
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {!loading && !photos.length ? (
        <p style={{ marginTop: 16, color: theme.colors.muted }}>
          {activeCategory
            ? "No published photos in this style yet. Try All Styles or another category."
            : "No published Discover photos yet."}
        </p>
      ) : null}

      {editPhoto ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "grid",
            placeItems: "center",
            zIndex: 40,
            padding: 16,
          }}
          onClick={() => setEditPhoto(null)}
        >
          <div
            style={{
              width: "min(420px, 100%)",
              background: theme.colors.bg || "#0b0b0b",
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 14,
              padding: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Edit photo</h3>
            <label style={{ display: "block", marginBottom: 10, fontSize: 13 }}>
              Title
              <input
                value={editPhoto.title}
                onChange={(e) => setEditPhoto((p) => ({ ...p, title: e.target.value }))}
                style={{ display: "block", width: "100%", marginTop: 4, padding: 10 }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 10, fontSize: 13 }}>
              Caption / description
              <textarea
                value={editPhoto.caption}
                onChange={(e) => setEditPhoto((p) => ({ ...p, caption: e.target.value }))}
                rows={3}
                style={{ display: "block", width: "100%", marginTop: 4, padding: 10 }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 14, fontSize: 13 }}>
              Category
              <select
                value={editPhoto.styleCategory || ""}
                onChange={(e) => setEditPhoto((p) => ({ ...p, styleCategory: e.target.value }))}
                style={{ display: "block", width: "100%", marginTop: 4, padding: 10 }}
              >
                <option value="">Select category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setEditPhoto(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => void saveEdit()} disabled={busyId === editPhoto.id}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Page>
  );
}
