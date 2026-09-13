import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { validatePasswordStrength } from "../lib/passwordPolicy.js";
import { userFacingForgotPasswordError } from "../lib/forgotPasswordErrors.js";
import { forgotPassword, resetPassword, verifyForgotPasswordCode } from "../services/api.js";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [status, setStatus] = useState(null);
  const [tone, setTone] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const showStatus = (message, nextTone) => {
    setStatus(message);
    setTone(nextTone);
  };

  const sendCode = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    showStatus(null, null);
    try {
      const data = await forgotPassword(email);
      showStatus(
        data?.message ||
          "If an account exists for that email and has a verified phone, a text with a reset code is on the way.",
        "success",
      );
      setStep("code");
    } catch (err) {
      console.error("[forgot-password]", {
        status: err?.status ?? err?.details?.status ?? null,
        error: err?.code ?? err?.details?.error ?? null,
        message: typeof err?.message === "string" ? err.message.slice(0, 200) : null,
      });
      showStatus(userFacingForgotPasswordError(err), "error");
    } finally {
      setSubmitting(false);
    }
  };

  const verifyCode = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    showStatus(null, null);
    try {
      const data = await verifyForgotPasswordCode({ email, code });
      const token = String(data?.resetToken || "").trim();
      if (!token) {
        showStatus("Could not verify that code. Try again.", "error");
        return;
      }
      setResetToken(token);
      setStep("password");
      showStatus("Code verified. Choose a new password.", "success");
    } catch (err) {
      console.error("[forgot-password-verify]", {
        status: err?.status ?? err?.details?.status ?? null,
        error: err?.code ?? err?.details?.error ?? null,
      });
      showStatus(userFacingForgotPasswordError(err), "error");
    } finally {
      setSubmitting(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    showStatus(null, null);
    if (password !== confirm) {
      showStatus("Passwords do not match.", "error");
      setSubmitting(false);
      return;
    }
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid) {
      showStatus(pwCheck.message, "error");
      setSubmitting(false);
      return;
    }
    try {
      await resetPassword({ token: resetToken, newPassword: password });
      setStep("success");
      showStatus("Password updated. You can sign in now.", "success");
      window.setTimeout(() => navigate("/login", { replace: true }), 900);
    } catch (err) {
      showStatus(userFacingForgotPasswordError(err), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <h1 className="auth-title">Reset Access</h1>
          <p className="auth-subtext">
            {step === "email"
              ? "We’ll text a 6-digit code to the verified phone on this account"
              : step === "code"
                ? "Enter the code from your text message"
                : step === "password"
                  ? "Min 12 characters with uppercase, lowercase, number, and symbol"
                  : "Your password was updated"}
          </p>
        </div>

        {step === "email" ? (
          <form onSubmit={sendCode} className="auth-form">
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
              {submitting ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : null}

        {step === "code" ? (
          <form onSubmit={verifyCode} className="auth-form">
            <div className="auth-field">
              <span className="auth-icon" aria-hidden>
                #
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                className="auth-input"
              />
            </div>
            <button type="submit" disabled={submitting} className="auth-btn">
              {submitting ? "Checking…" : "Verify code"}
            </button>
          </form>
        ) : null}

        {step === "password" ? (
          <form onSubmit={savePassword} className="auth-form">
            <div className="auth-field">
              <span className="auth-icon" aria-hidden>
                🔒
              </span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="auth-input"
              />
            </div>
            <div className="auth-field">
              <span className="auth-icon" aria-hidden>
                🔒
              </span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="auth-input"
              />
            </div>
            <button type="submit" disabled={submitting} className="auth-btn">
              {submitting ? "Updating…" : "Update password"}
            </button>
          </form>
        ) : null}

        {status ? (
          <p className={`auth-status ${tone === "success" ? "auth-status--success" : "auth-status--error"}`}>{status}</p>
        ) : null}

        <p className="auth-subtext" style={{ marginTop: 12 }}>
          If you use Sign in with Apple or Google, this sets a website password on the same account. Apple and Google
          sign-in keep working.
        </p>

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
