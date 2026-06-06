import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { login } from "../services/api.js";

export default function Login() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    email: "",
    password: "",
  });
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleLogin = async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      setStatus(null);
      setSubmitting(true);
      const data = await login(form.email, form.password);

      if (data.success) {
        console.log("USER:", data.user);
        if (data.token) localStorage.setItem("token", String(data.token));
        localStorage.setItem("user", JSON.stringify(data.user));
        const role = data?.user?.role;
        navigate(
          role === "super_admin" || role === "admin"
            ? "/admin"
            : role === "shop_owner"
              ? "/dashboard"
              : role === "barber"
                ? "/dashboard"
                : "/booking",
          { replace: true }
        );
      } else {
        setStatus("Invalid login");
      }
    } catch (err) {
      console.error("LOGIN ERROR:", err);
      setStatus(err?.message || "Server error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    handleLogin();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">Welcome Back</h1>
          <p className="auth-subtext">Sign in to access your dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              @
            </span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={form.email}
              onChange={handleChange}
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              🔒
            </span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={form.password}
              onChange={handleChange}
              className="auth-input"
            />
          </div>

          <button type="submit" className="auth-btn" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>

        {status ? <p className="auth-status auth-status--error">{status}</p> : null}

        <div className="auth-links">
          <Link to="/forgot-password" className="auth-link">
            Forgot Password?
          </Link>
          <div>
            Don&apos;t have an account?{" "}
            <Link to="/register" className="auth-link">
              Register
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
