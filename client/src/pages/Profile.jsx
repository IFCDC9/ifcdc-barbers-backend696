import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { authenticatedJson } from "../lib/authenticatedFetch.js";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

export default function Profile() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const u = readUser();
    setUser(u);
    if (!u) return;

    let token = "";
    try {
      token = localStorage.getItem("token") || "";
    } catch {
      /* ignore */
    }
    if (!token) return;

    setLoading(true);
    authenticatedJson("/api/auth/my-bookings")
      .then((data) => {
        const list = Array.isArray(data?.bookings) ? data.bookings : Array.isArray(data) ? data : [];
        setBookings(list);
      })
      .catch((e) => setError(e?.message || "Could not load bookings"))
      .finally(() => setLoading(false));
  }, []);

  const logout = () => {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {
      /* ignore */
    }
    navigate("/", { replace: true });
  };

  if (!user) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">Profile</h1>
        <p className="ifcdc-page-lead">Sign in to view your bookings and account.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          Sign in
        </Link>
        <Link to="/register" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          Create account
        </Link>
      </div>
    );
  }

  const role = String(user.role || "user");
  const canShop = role === "barber" || role === "shop_owner" || role === "admin" || role === "super_admin";
  const canPlatformAdmin = role === "admin" || role === "super_admin";

  return (
    <div className="ifcdc-profile">
      <h1 className="ifcdc-page-title">Profile</h1>
      <div className="ifcdc-book-wizard__summary">
        <p>
          <strong>Name:</strong> {user.name || "—"}
        </p>
        <p>
          <strong>Email:</strong> {user.email || "—"}
        </p>
        <p>
          <strong>Account:</strong>{" "}
          {role === "shop_owner" ? "Shop Admin" : role === "user" ? "Customer" : role}
        </p>
      </div>

      {canShop ? (
        <>
          <Link to="/barber-settings" className="ifcdc-book-wizard__cta">
            Shop settings
          </Link>
          {role === "barber" ? (
            <Link to="/profile/schedule" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
              My schedule
            </Link>
          ) : null}
        </>
      ) : null}

      <section className="ifcdc-profile-account" aria-label="Rewards and reviews">
        <h2 className="ifcdc-book-wizard__heading">Rewards &amp; reviews</h2>
        <Link to="/profile/rate-me" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          Rate Me
        </Link>
        <Link to="/profile/rewards" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          Rewards
        </Link>
      </section>
      {canPlatformAdmin ? (
        <Link to="/admin" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost">
          Platform admin
        </Link>
      ) : null}

      <section className="ifcdc-profile-account" aria-label="Account actions">
        <h2 className="ifcdc-book-wizard__heading">Account</h2>
        <button type="button" className="ifcdc-book-wizard__back" onClick={logout}>
          Sign out
        </button>
        <Link to="/profile/delete-account" className="ifcdc-delete-account__nav-btn">
          Delete account permanently
        </Link>
        <p className="ifcdc-page-hint ifcdc-delete-account__hint">
          Removes your sign-in, profile, and barber shop data where applicable.
        </p>
      </section>

      <h2 className="ifcdc-book-wizard__heading">My bookings</h2>
      {loading ? <p className="ifcdc-page-hint">Loading…</p> : null}
      {error ? <p className="ifcdc-error-msg">{error}</p> : null}
      {!loading && !bookings.length && !error ? (
        <p className="ifcdc-page-hint">No bookings yet. <Link to="/booking">Book now</Link></p>
      ) : null}
      <ul className="ifcdc-book-wizard__list">
        {bookings.map((b) => {
          const completed = String(b.booking_status || b.status || "").toLowerCase() === "completed";
          return (
            <li key={b.id} className="ifcdc-book-wizard__summary">
              <strong>{b.service || b.service_name || "Appointment"}</strong>
              <br />
              {b.barber_name || b.barberName || "Barber"} · {b.date || b.appointment_date} {b.time || b.appointment_time}
              <br />
              Status: {b.booking_status || b.status || "—"}
              {completed ? (
                <>
                  <br />
                  <Link to={`/profile/bookings/${b.id}/review`} className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" style={{ display: "inline-block", marginTop: 8 }}>
                    Leave a review
                  </Link>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
