import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { theme } from "../components/ui/theme.js";
import { fetchDiscoverPhotos, fetchPortfolioCategories } from "../services/socialPortfolioApi.js";

export default function StyleDiscoverPage() {
  const navigate = useNavigate();
  const [categories, setCategories] = React.useState([]);
  const [activeCategory, setActiveCategory] = React.useState("");
  const [photos, setPhotos] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    void fetchPortfolioCategories()
      .then((data) => setCategories(Array.isArray(data?.categories) ? data.categories : []))
      .catch(() => setCategories([]));
  }, []);

  React.useEffect(() => {
    setLoading(true);
    setError("");
    void fetchDiscoverPhotos({ styleCategory: activeCategory || undefined, limit: 48 })
      .then((data) => setPhotos(Array.isArray(data?.photos) ? data.photos : []))
      .catch((e) => {
        setError(e?.message || "Failed to load photos");
        setPhotos([]);
      })
      .finally(() => setLoading(false));
  }, [activeCategory]);

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

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button
          type="button"
          onClick={() => setActiveCategory("")}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: `1px solid ${!activeCategory ? theme.colors.accent : theme.colors.border}`,
            background: !activeCategory ? theme.colors.indigoBg : "transparent",
            color: theme.colors.text,
            cursor: "pointer",
          }}
        >
          All styles
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setActiveCategory(cat.id)}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: `1px solid ${activeCategory === cat.id ? theme.colors.accent : theme.colors.border}`,
              background: activeCategory === cat.id ? theme.colors.indigoBg : "transparent",
              color: theme.colors.text,
              cursor: "pointer",
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

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
        {photos.map((photo) => (
          <Card
            key={photo.id}
            style={{ padding: 0, overflow: "hidden", cursor: photo.barberSlug ? "pointer" : "default" }}
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
              {photo.likeCount ? (
                <div style={{ color: theme.colors.muted, marginTop: 4 }}>♥ {photo.likeCount}</div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      {!loading && !photos.length ? (
        <p style={{ marginTop: 16, color: theme.colors.muted }}>No photos in this category yet.</p>
      ) : null}
    </Page>
  );
}
