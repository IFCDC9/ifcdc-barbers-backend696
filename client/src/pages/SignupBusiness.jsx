import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getApiBase, login } from "../services/api.js";

const initial = {
  name: "",
  email: "",
  password: "",
  businessName: "",
  businessPhone: "",
  barberName: "",
  serviceName: "General cut",
  servicePrice: "25",
};

export default function SignupBusiness() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initial);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState(null);
  const [statusTone, setStatusTone] = useState("error");
  const [showSignInAction, setShowSignInAction] = useState(false);
  const [busy, setBusy] = useState(false);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  };

  const submit = async () => {
    setStatus(null);
    setShowSignInAction(false);
    setStatusTone("error");
    setBusy(true);
    try {
      const base = getApiBase();
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        businessName: form.businessName.trim(),
        businessPhone: form.businessPhone.trim() || undefined,
        barberName: (form.barberName.trim() || form.name.trim() || "Owner").trim(),
        serviceName: (form.serviceName.trim() || "General cut").trim(),
        servicePrice: Number(form.servicePrice) || 25,
      };

      const postOnboarding = async (bearerToken) => {
        const headers = { "Content-Type": "application/json", Accept: "application/json" };
        if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
        const res = await fetch(`${base}/api/onboarding/business`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        let data = {};
        try {
          const text = await res.text();
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        return { res, data };
      };

      let { res, data } = await postOnboarding();

      const handleResponse = () => {
        console.log("API RESPONSE:", { httpStatus: res.status, ok: res.ok, data });

        const marksSuccess = data?.success === true || data?.ok === true;

        if (res.ok && marksSuccess && data?.token) {
          localStorage.setItem("token", String(data.token));
          if (data.user) localStorage.setItem("user", JSON.stringify(data.user));
          if (data.existing === true) {
            console.log("Existing user — continuing onboarding");
          }
          navigate("/website-studio", { replace: true });
          return true;
        }

        const loginRequired =
          res.status === 401 && (data.loginRequired === true || data.error === "invalid_credentials");

        if (loginRequired) {
          setStatusTone("warn");
          setShowSignInAction(true);
          setStatus("Account exists — please sign in to continue");
          return true;
        }

        const duplicateOrRegistered =
          res.status === 409 ||
          String(data?.error || "").toLowerCase() === "email_exists" ||
          /already\s*registered|email\s*is\s*already|email_exists/i.test(String(data?.message || ""));

        if (duplicateOrRegistered) {
          return { duplicateOrRegistered: true };
        }

        setStatusTone("error");
        setStatus(data.message || data.error || `Signup failed (${res.status})`);
        return true;
      };

      let handled = handleResponse();
      if (handled === true) return;
      if (handled?.duplicateOrRegistered) {
        const loginData = await login(form.email.trim(), form.password);
        if (!loginData?.success || !loginData?.token) {
          setStatusTone("warn");
          setShowSignInAction(true);
          setStatus("Account exists — please sign in to continue");
          return;
        }
        localStorage.setItem("token", String(loginData.token));
        if (loginData.user) localStorage.setItem("user", JSON.stringify(loginData.user));

        const retry = await postOnboarding(loginData.token);
        res = retry.res;
        data = retry.data;
        handled = handleResponse();
        if (handled === true) return;
        if (handled?.duplicateOrRegistered) {
          setStatusTone("warn");
          setShowSignInAction(true);
          setStatus("Account exists — please sign in to continue");
        }
        return;
      }
    } catch (err) {
      setStatusTone("error");
      setStatus(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const steps = ["Account", "Business", "Barber & service", "Review"];

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <h1 className="auth-title">New shop onboarding</h1>
        <p className="auth-subtext">
          Create your owner account, business, first barber profile, and a default service in one step. Solo barber? Try{" "}
          <Link to="/onboarding/barber" className="auth-link">
            premium barber onboarding
          </Link>
          .
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {steps.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`ifcdc-onboarding-pill${step === i ? " step-active" : ""}`}
              onClick={() => setStep(i)}
            >
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (step < steps.length - 1) return;
            void submit();
          }}
        >
          {step === 0 ? (
            <>
              <input name="name" className="auth-input" placeholder="Your name" value={form.name} onChange={onChange} />
              <input
                name="email"
                type="email"
                className="auth-input"
                placeholder="Email"
                value={form.email}
                onChange={onChange}
                autoComplete="email"
              />
              <input
                name="password"
                type="password"
                className="auth-input"
                placeholder="Password (12+ chars, upper, lower, number, symbol)"
                value={form.password}
                onChange={onChange}
                autoComplete="new-password"
              />
            </>
          ) : null}

          {step === 1 ? (
            <>
              <input
                name="businessName"
                className="auth-input"
                placeholder="Business / shop name"
                value={form.businessName}
                onChange={onChange}
              />
              <input
                name="businessPhone"
                className="auth-input"
                placeholder="Shop phone (optional)"
                value={form.businessPhone}
                onChange={onChange}
              />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <input
                name="barberName"
                className="auth-input"
                placeholder="Barber display name (defaults to your name)"
                value={form.barberName}
                onChange={onChange}
              />
              <input
                name="serviceName"
                className="auth-input"
                placeholder="First service name"
                value={form.serviceName}
                onChange={onChange}
              />
              <input
                name="servicePrice"
                type="number"
                min="0"
                step="0.01"
                className="auth-input"
                placeholder="Service price (USD)"
                value={form.servicePrice}
                onChange={onChange}
              />
            </>
          ) : null}

          {step === 3 ? (
            <div className="auth-subtext" style={{ textAlign: "left" }}>
              <p>
                <strong>Account:</strong> {form.name || "—"} · {form.email || "—"}
              </p>
              <p>
                <strong>Business:</strong> {form.businessName || "—"}
              </p>
              <p>
                <strong>Barber:</strong> {(form.barberName || form.name || "Owner").trim()}
              </p>
              <p>
                <strong>Service:</strong> {form.serviceName || "General cut"} @ $
                {Number(form.servicePrice) > 0 ? Number(form.servicePrice).toFixed(2) : "25.00"}
              </p>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            {step > 0 ? (
              <button type="button" className="auth-link" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </button>
            ) : null}
            {step < steps.length - 1 ? (
              <button type="button" className="ifcdc-booking-confirm-btn" onClick={() => setStep((s) => s + 1)}>
                Next
              </button>
            ) : (
              <button type="submit" className="ifcdc-booking-confirm-btn" disabled={busy}>
                {busy ? "Creating…" : "Create shop"}
              </button>
            )}
          </div>
        </form>

        {status ? (
          <p
            style={{
              marginTop: 12,
              color: statusTone === "success" ? "#6c6" : statusTone === "warn" ? "#ecbe62" : "#f88",
            }}
          >
            {status}
          </p>
        ) : null}
        {showSignInAction ? (
          <Link
            to="/login"
            className="ifcdc-booking-confirm-btn"
            style={{ display: "inline-block", marginTop: 14, textAlign: "center", textDecoration: "none" }}
          >
            Sign In
          </Link>
        ) : null}

        <p className="auth-subtext" style={{ marginTop: 16 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
