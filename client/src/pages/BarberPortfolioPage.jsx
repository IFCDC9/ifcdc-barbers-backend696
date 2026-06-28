import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card, CardTitle } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { getStoredToken } from "../lib/authHeaders.js";
import {
  fetchPublicPortfolio,
  followBarber,
  togglePhotoLike,
  unfollowBarber,
} from "../services/socialPortfolioApi.js";
import StyleCoverImage from "../components/StyleCoverImage.jsx";
import { isRenderableStyleImageUrl } from "../lib/styleImageUrl.js";

function Stars({ value }) {
  const n = Math.round(Number(value) || 0);
  return (
    <span aria-label={`${value} out of 5 stars`} style={{ color: theme.colors.accent, letterSpacing: 2 }}>
      {"★".repeat(Math.min(5, n))}
      <span style={{ color: theme.colors.muted }}>{"★".repeat(Math.max(0, 5 - n))}</span>
    </span>
  );
}

function sharePortfolio(portfolio) {
  const url = `${window.location.origin}/p/${portfolio.slug}`;
  const text = `Check out ${portfolio.name} on IFCDC Barbers`;
  if (navigator.share) {
    void navigator.share({ title: portfolio.name, text, url }).catch(() => {});
    return;
  }
  void navigator.clipboard?.writeText(url);
  window.alert("Portfolio link copied to clipboard.");
}

export default function BarberPortfolioPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const token = getStoredToken();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [portfolio, setPortfolio] = React.useState(null);
  const [busy, setBusy] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchPublicPortfolio(slug);
      setPortfolio(data.portfolio || null);
    } catch (e) {
      setError(e?.message || "Failed to load portfolio");
      setPortfolio(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onFollow = async () => {
    if (!token) {
      navigate("/login");
      return;
    }
    if (!portfolio) return;
    setBusy("follow");
    try {
      if (portfolio.isFollowing) {
        await unfollowBarber(portfolio.id);
        setPortfolio((p) => ({ ...p, isFollowing: false, followerCount: Math.max(0, (p.followerCount || 1) - 1) }));
      } else {
        await followBarber(portfolio.id);
        setPortfolio((p) => ({ ...p, isFollowing: true, followerCount: (p.followerCount || 0) + 1 }));
      }
    } catch (e) {
      setError(e?.message || "Action failed");
    } finally {
      setBusy("");
    }
  };

  const onLike = async (photoId) => {
    if (!token) {
      navigate("/login");
      return;
    }
    try {
      const result = await togglePhotoLike(photoId);
      setPortfolio((p) => ({
        ...p,
        gallery: (p.gallery || []).map((photo) =>
          photo.id === photoId
            ? {
                ...photo,
                likedByViewer: result.liked,
                likeCount: Math.max(0, (photo.likeCount || 0) + (result.liked ? 1 : -1)),
              }
            : photo,
        ),
      }));
    } catch (e) {
      setError(e?.message || "Like failed");
    }
  };

  if (loading) {
    return (
      <Page>
        <p style={{ color: theme.colors.muted, marginTop: 24 }}>Loading portfolio…</p>
      </Page>
    );
  }

  if (error || !portfolio) {
    return (
      <Page>
        <PageHeader title="Barber not found" subtitle={error || "This profile is unavailable."} />
        <Link to="/discover" style={{ color: theme.colors.accent }}>Browse styles</Link>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={portfolio.name}
        subtitle={portfolio.headline || portfolio.shop?.name || "Professional barber portfolio"}
        right={
          <Link to="/discover" style={{ color: theme.colors.text, fontWeight: 700 }}>
            Discover
          </Link>
        }
      />

      <Card style={{ marginTop: 16, display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          {portfolio.profileImage ? (
            <img
              src={portfolio.profileImage}
              alt=""
              style={{ width: 96, height: 96, borderRadius: "50%", objectFit: "cover", border: `2px solid ${theme.colors.accent}` }}
            />
          ) : null}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Stars value={portfolio.averageRating} />
              <span style={{ color: theme.colors.muted }}>
                {portfolio.averageRating.toFixed(1)} · {portfolio.reviewCount} review{portfolio.reviewCount === 1 ? "" : "s"}
              </span>
            </div>
            {portfolio.yearsExperience != null && portfolio.yearsExperience > 0 ? (
              <p style={{ margin: "8px 0 0", color: theme.colors.muted }}>{portfolio.yearsExperience}+ years experience</p>
            ) : null}
            {portfolio.shop?.locationLabel ? (
              <p style={{ margin: "4px 0 0", color: theme.colors.muted }}>{portfolio.shop.locationLabel}</p>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {(portfolio.badges || []).map((badge) => (
                <span
                  key={badge.key}
                  title={badge.description}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: theme.colors.indigoBg,
                    border: `1px solid ${theme.colors.indigoBorder}`,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {badge.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {portfolio.bookable ? (
            <Button variant="indigo" type="button" onClick={() => navigate(`/booking?barberId=${encodeURIComponent(portfolio.id)}`)}>
              Book now
            </Button>
          ) : null}
          <Button variant="ghost" type="button" disabled={busy === "follow"} onClick={() => void onFollow()}>
            {portfolio.isFollowing ? "Following" : "Follow"}
          </Button>
          <Button variant="ghost" type="button" onClick={() => sharePortfolio(portfolio)}>
            Share
          </Button>
        </div>

        {portfolio.bio ? <p style={{ margin: 0, color: theme.colors.muted, lineHeight: 1.6 }}>{portfolio.bio}</p> : null}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Services & portfolio</CardTitle>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {(portfolio.services || []).length ? (
            portfolio.services.map((service) => (
              <div
                key={service.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "10px 0",
                  borderBottom: `1px solid ${theme.colors.border}`,
                }}
              >
                <div style={{ width: 80, height: 80, flexShrink: 0, borderRadius: theme.radius.sm, overflow: "hidden" }}>
                  <StyleCoverImage
                    bare
                    styleId={service.id}
                    barberId={portfolio.id}
                    imageUrl={isRenderableStyleImageUrl(service.imageUrl) ? service.imageUrl : ""}
                    alt={service.name || ""}
                    className="ifcdc-cover-media__img ifcdc-cover-fill"
                    frameClassName="ifcdc-cover-media"
                    logContext="portfolio-service"
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{service.name}</strong>
                  {service.description ? (
                    <p style={{ margin: "4px 0 0", color: theme.colors.muted, fontSize: 13 }}>{service.description}</p>
                  ) : null}
                  {service.durationMinutes ? (
                    <p style={{ margin: "4px 0 0", color: theme.colors.muted, fontSize: 12 }}>{service.durationMinutes} min</p>
                  ) : null}
                </div>
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {service.price != null ? <strong>${Number(service.price).toFixed(0)}</strong> : null}
                </div>
              </div>
            ))
          ) : (
            <p style={{ color: theme.colors.muted }}>Services will appear here once configured.</p>
          )}
        </div>
      </Card>

      {(portfolio.gallery || []).length ? (
      <Card style={{ marginTop: 16 }}>
        <CardTitle>Style gallery</CardTitle>
        <div
          style={{
            display: "grid",
            gap: 12,
            marginTop: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          }}
        >
          {(portfolio.gallery || []).map((photo) => (
            <figure key={photo.id} style={{ margin: 0 }}>
              <img
                src={photo.thumbnailUrl || photo.photoUrl}
                alt={photo.caption || "Haircut photo"}
                style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: theme.radius.sm }}
              />
              <figcaption style={{ marginTop: 6, fontSize: 12 }}>
                <div style={{ fontWeight: 700 }}>{photo.serviceName || photo.caption || "Style"}</div>
                {photo.price != null ? (
                  <div style={{ color: theme.colors.muted }}>${Number(photo.price).toFixed(0)}</div>
                ) : null}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => void onLike(photo.id)}
                    style={{ background: "none", border: "none", color: photo.likedByViewer ? theme.colors.accent : theme.colors.muted, cursor: "pointer" }}
                  >
                    ♥ {photo.likeCount || 0}
                  </button>
                  {photo.is30DayFollowup ? <span style={{ color: theme.colors.muted }}>30-day</span> : null}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <CardTitle>Customer reviews</CardTitle>
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {(portfolio.reviews || []).map((review) => (
            <div key={review.id} style={{ paddingBottom: 12, borderBottom: `1px solid ${theme.colors.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>{review.customerName}</strong>
                {review.verifiedClient !== false ? (
                  <span style={{ ...pillStyle("gold"), marginLeft: 8, fontSize: 10 }}>✓ Verified Client</span>
                ) : null}
                <Stars value={review.rating} />
              </div>
              {review.comment ? <p style={{ margin: "8px 0 0", color: theme.colors.muted }}>{review.comment}</p> : null}
            </div>
          ))}
          {!portfolio.reviews?.length ? <p style={{ color: theme.colors.muted }}>No reviews yet.</p> : null}
        </div>
      </Card>

      {portfolio.shop?.name || portfolio.shop?.phone ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Shop information</CardTitle>
          <p style={{ margin: "12px 0 0", color: theme.colors.muted, lineHeight: 1.6 }}>
            {portfolio.shop.name ? (
              <>
                <strong>Shop:</strong> {portfolio.shop.name}
                <br />
              </>
            ) : null}
            {portfolio.shop.address ? (
              <>
                <strong>Address:</strong> {portfolio.shop.address}
                <br />
              </>
            ) : null}
            {portfolio.shop.phone ? (
              <>
                <strong>Phone:</strong> {portfolio.shop.phone}
              </>
            ) : null}
          </p>
        </Card>
      ) : null}
    </Page>
  );
}
