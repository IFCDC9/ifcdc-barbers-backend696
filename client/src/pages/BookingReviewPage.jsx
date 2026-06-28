import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { theme } from "../components/ui/theme.js";
import {
  deleteCustomerReview,
  fetchBookingReviewStatus,
  fetchPortfolioCategories,
  submitBookingReview,
  updateCustomerReview,
  uploadReviewPhotos,
} from "../services/socialPortfolioApi.js";

function Stars({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange?.(n)}
          style={{
            fontSize: 28,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: n <= value ? theme.colors.accent : theme.colors.muted,
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export default function BookingReviewPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(null);
  const [rating, setRating] = React.useState(5);
  const [comment, setComment] = React.useState("");
  const [styleCategory, setStyleCategory] = React.useState("");
  const [categories, setCategories] = React.useState([]);
  const [photos, setPhotos] = React.useState([]);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    void fetchPortfolioCategories()
      .then((data) => setCategories(data?.categories || []))
      .catch(() => setCategories([]));
  }, []);

  React.useEffect(() => {
    if (!bookingId) return;
    setLoading(true);
    void fetchBookingReviewStatus(bookingId)
      .then((data) => {
        setStatus(data);
        if (data.rating) setRating(Number(data.rating));
        if (data.comment) setComment(String(data.comment));
      })
      .catch((e) => setError(e?.message || "Could not load review status"))
      .finally(() => setLoading(false));
  }, [bookingId]);

  const editMode = Boolean(status?.hasReview && status?.canEdit);

  const onSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editMode && status?.reviewId) {
        await updateCustomerReview(status.reviewId, { rating, comment: comment.trim() });
        alert("Review updated.");
        navigate("/profile");
        return;
      }
      const result = await submitBookingReview(bookingId, { rating, comment: comment.trim(), photos: [] });
      const reviewId = result?.review?.id;
      if (reviewId && photos.length) {
        await uploadReviewPhotos(reviewId, photos, {
          photoType: "after",
          styleCategory: styleCategory || undefined,
          caption: comment.trim() || undefined,
        });
      }
      alert("Thank you — your review has been submitted.");
      navigate("/profile");
    } catch (err) {
      setError(err?.message || "Could not submit review");
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!status?.reviewId || !window.confirm("Delete your review?")) return;
    setBusy(true);
    try {
      await deleteCustomerReview(status.reviewId);
      alert("Review deleted.");
      navigate("/profile");
    } catch (err) {
      setError(err?.message || "Could not delete review");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Page>
        <p style={{ color: theme.colors.muted }}>Loading…</p>
      </Page>
    );
  }

  if (!status?.canReview && !editMode) {
    return (
      <Page>
        <PageHeader title="Review unavailable" subtitle={status?.reason || "This appointment cannot be reviewed."} />
        <Link to="/profile">Back to profile</Link>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={editMode ? "Edit your review" : "Rate your visit"}
        subtitle="Only verified clients with completed appointments can leave reviews."
      />
      <Card>
        <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
          <div>
            <label style={{ display: "block", marginBottom: 8, color: theme.colors.muted }}>Your rating</label>
            <Stars value={rating} onChange={setRating} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 8, color: theme.colors.muted }}>Your review</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={5}
              style={{ width: "100%", padding: 12, borderRadius: 8, border: `1px solid ${theme.colors.border}` }}
              placeholder="Tell others about your experience…"
            />
          </div>
          {!editMode ? (
            <>
              {categories.length ? (
                <div>
                  <label style={{ display: "block", marginBottom: 8, color: theme.colors.muted }}>Style category</label>
                  <select value={styleCategory} onChange={(e) => setStyleCategory(e.target.value)}>
                    <option value="">Select (optional)</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label style={{ display: "block", marginBottom: 8, color: theme.colors.muted }}>Photos (optional)</label>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setPhotos(Array.from(e.target.files || []))}
                />
              </div>
            </>
          ) : null}
          {error ? <p style={{ color: "#f87171" }}>{error}</p> : null}
          <button type="submit" disabled={busy} className="ifcdc-book-wizard__cta">
            {busy ? "Saving…" : editMode ? "Save changes" : "Submit review"}
          </button>
          {editMode && status?.canDelete ? (
            <button type="button" disabled={busy} className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={() => void onDelete()}>
              Delete review
            </button>
          ) : null}
        </form>
      </Card>
    </Page>
  );
}
