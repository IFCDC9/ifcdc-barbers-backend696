import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { validatePasswordStrength } from "../lib/passwordPolicy.js";
import { resetPassword } from "../services/api.js";

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export default function ResetPassword() {
  const q = useQuery();
  const navigate = useNavigate();
  const token = String(q.get("token") || "").trim();

  const [pw, setPw] = useState("");
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    setTone(null);
    const pwCheck = validatePasswordStrength(pw);
    if (!pwCheck.valid) {
      setStatus(pwCheck.message);
      setTone("error");
      setSubmitting(false);
      return;
    }
    try {
      await resetPassword({ token, newPassword: pw });
      setStatus("Password updated. You can sign in now.");
      setTone("success");
      window.setTimeout(() => navigate("/login", { replace: true }), 900);
    } catch (err) {
      setStatus(err?.message || "Reset failed");
      setTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">Create New Password</h1>
          <p className="auth-subtext">Min 12 characters with uppercase, lowercase, number, and symbol</p>
        </div>

        {!token ? (
          <p className="auth-status auth-status--error">Missing reset token. Open the link from your email.</p>
        ) : (
          <form onSubmit={submit} className="auth-form">
            <div className="auth-field">
              <span className="auth-icon" aria-hidden>
                🔒
              </span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                className="auth-input"
              />
            </div>

            <button type="submit" disabled={submitting} className="auth-btn">
              {submitting ? "Updating…" : "Update password"}
            </button>
          </form>
        )}

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

