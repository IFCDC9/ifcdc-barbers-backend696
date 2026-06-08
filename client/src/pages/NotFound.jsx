import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="page" style={{ padding: "2rem 1rem", textAlign: "center" }}>
      <h1 className="ifcdc-page-title">Page not found</h1>
      <p className="ifcdc-page-hint" style={{ marginBottom: "1.5rem" }}>
        That link may be outdated or mistyped.
      </p>
      <Link to="/" className="auth-link">
        Back to Home
      </Link>
      {" · "}
      <Link to="/booking" className="auth-link">
        Book appointment
      </Link>
    </div>
  );
}
