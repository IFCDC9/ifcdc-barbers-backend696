import { useState } from "react";
import { Link } from "react-router-dom";
import { validatePasswordStrength } from "../lib/passwordPolicy.js";
import { register } from "../services/api.js";

export default function Register() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "user",
  });
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);
    setTone(null);
    const pwCheck = validatePasswordStrength(form.password);
    if (!pwCheck.valid) {
      setStatus(pwCheck.message);
      setTone("error");
      return;
    }
    setSubmitting(true);
    try {
      await register(form);
      setStatus("Account created! You can sign in.");
      setTone("success");
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Error registering");
      setTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">Create Account</h1>
          <p className="auth-subtext">Join IFCDC Barbers and manage your appointments</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              👤
            </span>
            <input
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Name"
              value={form.name}
              onChange={handleChange}
              className="auth-input"
            />
          </div>

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
              autoComplete="new-password"
              placeholder="Password"
              value={form.password}
              onChange={handleChange}
              className="auth-input"
            />
          </div>
          <p className="auth-subtext" style={{ margin: "-4px 0 8px", fontSize: "0.85rem", opacity: 0.85 }}>
            Min 12 characters: uppercase, lowercase, number, and symbol. Common passwords are rejected.
          </p>

          <div className="auth-field">
            <span className="auth-icon" aria-hidden>
              ⌄
            </span>
            <select name="role" value={form.role} onChange={handleChange} className="auth-input" aria-label="Account type">
              <option value="user">Client</option>
              <option value="barber">Barber</option>
              <option value="shop_owner">Admin</option>
            </select>
            <p className="auth-subtext" style={{ margin: "4px 0 0", fontSize: "0.8rem", opacity: 0.75 }}>
              Admin manages your own shop only.
            </p>
          </div>

          <button type="submit" disabled={submitting} className="auth-btn">
            {submitting ? "Creating…" : "Create Account"}
          </button>
        </form>

        {status ? (
          <p className={`auth-status ${tone === "success" ? "auth-status--success" : "auth-status--error"}`}>{status}</p>
        ) : null}

        <div className="auth-links">
          <div>
            Already have an account?{" "}
            <Link to="/login" className="auth-link">
              Sign In
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
