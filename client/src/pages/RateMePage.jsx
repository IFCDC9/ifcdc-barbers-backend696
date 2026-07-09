import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchReviewableBookings } from "../services/socialPortfolioApi.js";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

export default function RateMePage() {
  const navigate = useNavigate();
  const user = readUser();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchReviewableBookings()
      .then((data) => setRows(Array.isArray(data?.bookings) ? data.bookings : []))
      .catch((e) => setError(e?.message || "Could not load"))
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) {
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
      {error ? <p className="ifcdc-error-msg">{error}</p> : null}
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
