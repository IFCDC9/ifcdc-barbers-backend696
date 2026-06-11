import { useState } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../services/api.js";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    setTone(null);
    try {
      const data = await forgotPassword(email);
      setStatus(
        data?.message ||
          "If an account exists for that email, a password reset link is on the way.",
      );
      setTone("success");
    } catch (err) {
      setStatus(err?.message || "Could not send reset email. Please try again.");
      setTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">Reset Access</h1>
          <p className="auth-subtext">We’ll email you a secure password reset link</p>
        </div>

        <form onSubmit={submit} className="auth-form">
          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              @
            </span>
            <input
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="auth-input"
            />
          </div>

          <button type="submit" disabled={submitting} className="auth-btn">
            {submitting ? "Sending…" : "Send reset link"}
          </button>
        </form>

        {status ? (
          <p className={`auth-status ${tone === "success" ? "auth-status--success" : "auth-status--error"}`}>{status}</p>
        ) : null}

        <div className="auth-links">
          <div>
            Back to{" "}
            <Link to="/login" className="auth-link">
              Sign In
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

