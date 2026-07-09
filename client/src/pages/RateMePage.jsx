import { Link, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { fetchReviewableBookings } from "../services/socialPortfolioApi.js";
import { hasWebSession } from "../lib/appSession.js";

export default function RateMePage() {
  const navigate = useNavigate();
  const signedIn = hasWebSession();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!hasWebSession()) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchReviewableBookings();
      setRows(Array.isArray(data?.bookings) ? data.bookings : []);
    } catch (e) {
      const msg = String(e?.message || "Could not load reviews");
      setError(
        msg.includes("Network error") || msg.includes("timed out")
          ? "Could not reach the server. Wait a moment and tap Try again."
          : msg,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!signedIn) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">Rate Me</h1>
        <p className="ifcdc-page-lead">Sign in to leave reviews after completed visits.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="ifcdc-profile">
      <button type="button" className="ifcdc-book-wizard__back" onClick={() => navigate("/profile")}>
        ← Profile
      </button>
      <h1 className="ifcdc-page-title">Rate Me</h1>
      <p className="ifcdc-page-lead">Verified reviews appear on your barber&apos;s public profile.</p>
      {loading ? <p className="ifcdc-page-hint">Loading…</p> : null}
      {error ? (
        <div className="ifcdc-error-msg">
          <p>{error}</p>
          <button type="button" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {!loading && !rows.length && !error ? (
        <p className="ifcdc-page-hint">No completed visits waiting for a review.</p>
      ) : null}
      <ul className="ifcdc-book-wizard__list">
        {rows.map((b) => (
          <li key={b.id} className="ifcdc-book-wizard__summary">
            <strong>{b.service || "Appointment"}</strong>
            <br />
            {b.barberName || b.barber_name} · {b.date} {b.time}
            <br />
            <Link
              to={`/profile/bookings/${b.id}/review`}
              className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost"
              style={{ display: "inline-block", marginTop: 8 }}
            >
              Leave a review
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
