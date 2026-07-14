import React from "react";
import { Link, Navigate } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { getStoredToken, getStoredUser } from "../lib/authHeaders.js";
import {
  fetchAdminReviews,
  fetchContentReports,
  hidePhoto,
  hideReview,
  removeReview,
  resolveContentReport,
  restoreReviewAdmin,
} from "../services/socialPortfolioApi.js";

export default function AdminContentModeration() {
  const user = getStoredUser();
  const token = getStoredToken();
  const [reports, setReports] = React.useState([]);
  const [reviews, setReviews] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [busyId, setBusyId] = React.useState("");
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [stars, setStars] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [j, r] = await Promise.all([
        fetchContentReports().catch(() => ({ reports: [] })),
        fetchAdminReviews({ q, status, stars }).catch(() => ({ reviews: [] })),
      ]);
      setReports(Array.isArray(j?.reports) ? j.reports : []);
      setReviews(Array.isArray(r?.reviews) ? r.reviews : []);
    } catch (e) {
      setError(e?.message || "Failed to load moderation data");
      setReports([]);
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [q, status, stars]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!user || !token || (user.role !== "admin" && user.role !== "super_admin")) {
    return <Navigate to="/login" replace />;
  }

  const act = async (report, action) => {
    setBusyId(report.id);
    try {
      if (action === "hide") {
        if (report.targetType === "review") await hideReview(report.targetId);
        else await hidePhoto(report.targetId);
        await resolveContentReport(report.id, { status: "action_taken" });
      } else if (action === "remove") {
        if (report.targetType === "review") await removeReview(report.targetId, report.reason || "policy_violation");
        else await hidePhoto(report.targetId);
        await resolveContentReport(report.id, { status: "action_taken", adminNotes: "Content removed by admin" });
      } else {
        await resolveContentReport(report.id, { status: "dismissed" });
      }
      await load();
    } catch (e) {
      setError(e?.message || "Action failed");
    } finally {
      setBusyId("");
    }
  };

  const moderateReview = async (review, action) => {
    setBusyId(review.id);
    try {
      if (action === "hide") await hideReview(review.id);
      else if (action === "remove") await removeReview(review.id, "policy_violation");
      else if (action === "restore") await restoreReviewAdmin(review.id, "restored");
      await load();
    } catch (e) {
      setError(e?.message || "Action failed");
    } finally {
      setBusyId("");
    }
  };

  return (
    <Page>
      <PageHeader
        title="Content moderation"
        subtitle="Reports, hide/restore/remove reviews — emails sent to service@ifcdc.org"
        right={
          <Link to="/admin" style={{ color: theme.colors.text, fontWeight: 800 }}>
            ← Admin
          </Link>
        }
      />

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Search reviews</CardTitle>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Client, barber, shop, booking, text…"
            style={{ flex: 1, minWidth: 220, padding: 10, borderRadius: 8, border: `1px solid ${theme.colors.border}` }}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 10, borderRadius: 8 }}>
            <option value="all">All statuses</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden</option>
            <option value="removed">Removed</option>
            <option value="reported">Reported</option>
          </select>
          <select value={stars} onChange={(e) => setStars(e.target.value)} style={{ padding: 10, borderRadius: 8 }}>
            <option value="">All stars</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={String(n)}>
                {n}★
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>

      {loading ? <p style={{ color: theme.colors.muted, marginTop: 16 }}>Loading…</p> : null}
      {error ? <p style={{ color: "#f87171", marginTop: 16 }}>{error}</p> : null}

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Pending reports ({reports.length})</CardTitle>
        {!loading && !reports.length ? (
          <p style={{ color: theme.colors.muted, marginTop: 12 }}>No pending reports.</p>
        ) : null}
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {reports.map((report) => (
            <div key={report.id} style={{ borderBottom: `1px solid ${theme.colors.border}`, paddingBottom: 12 }}>
              <strong>
                {report.targetType === "review" ? "Review" : "Photo"} · {report.reason}
              </strong>
              <p style={{ color: theme.colors.muted, fontSize: 14, marginTop: 8 }}>Target: {report.targetId}</p>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <Button type="button" variant="ghost" disabled={busyId === report.id} onClick={() => void act(report, "hide")}>
                  Hide
                </Button>
                {report.targetType === "review" ? (
                  <Button type="button" variant="ghost" disabled={busyId === report.id} onClick={() => void act(report, "remove")}>
                    Remove
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" disabled={busyId === report.id} onClick={() => void act(report, "dismiss")}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardTitle>All reviews ({reviews.length})</CardTitle>
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {reviews.map((review) => (
            <div key={review.id} style={{ borderBottom: `1px solid ${theme.colors.border}`, paddingBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>
                  {review.customerName} · {review.rating}★ · {review.status}
                </strong>
                <span style={{ color: theme.colors.muted, fontSize: 12 }}>{review.createdAt}</span>
              </div>
              <p style={{ color: theme.colors.muted, margin: "6px 0 0" }}>
                {review.barberName || "Barber"}
                {review.shopName ? ` · ${review.shopName}` : ""}
                {review.bookingId ? ` · booking ${review.bookingId}` : ""}
              </p>
              {review.comment ? <p style={{ margin: "8px 0 0" }}>{review.comment}</p> : null}
              {(review.photos || []).length ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {review.photos.map((p) => (
                    <img key={p.id} src={p.thumbnailUrl || p.photoUrl} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8 }} />
                  ))}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {review.status !== "hidden" && review.status !== "removed" ? (
                  <Button type="button" variant="ghost" disabled={busyId === review.id} onClick={() => void moderateReview(review, "hide")}>
                    Hide
                  </Button>
                ) : null}
                {review.status === "hidden" || review.status === "removed" ? (
                  <Button type="button" variant="ghost" disabled={busyId === review.id} onClick={() => void moderateReview(review, "restore")}>
                    Restore
                  </Button>
                ) : null}
                {review.status !== "removed" ? (
                  <Button type="button" variant="ghost" disabled={busyId === review.id} onClick={() => void moderateReview(review, "remove")}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {!loading && !reviews.length ? <p style={{ color: theme.colors.muted }}>No reviews match this filter.</p> : null}
        </div>
      </Card>
    </Page>
  );
}
