import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import StepIdentity from "../components/onboarding/StepIdentity.jsx";
import StepLocation from "../components/onboarding/StepLocation.jsx";
import StepServices from "../components/onboarding/StepServices.jsx";
import StepBranding from "../components/onboarding/StepBranding.jsx";
import StepPayment from "../components/onboarding/StepPayment.jsx";
import StepLaunch from "../components/onboarding/StepLaunch.jsx";
import {
  postBarberOnboardRegister,
  putBarberProfile,
  postOnboardServices,
  postBarberMedia,
  postOnboardComplete,
} from "../services/barberOnboardingApi.js";
import { login } from "../services/api.js";
import "../styles/barber-onboarding.css";

const STEPS = 6;
const STORAGE_KEY = "ifcdc_barber_onboarding_v1";

const defaultDraft = () => ({
  name: "",
  email: "",
  password: "",
  displayName: "",
  shopName: "",
  phone: "",
  bio: "",
  address: "",
  latitude: "",
  longitude: "",
  services: [{ name: "Signature cut", price: "35", duration_minutes: 30 }],
  logoFile: null,
  profileFile: null,
});

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultDraft();
    const j = JSON.parse(raw);
    return { ...defaultDraft(), ...j, logoFile: null, profileFile: null, password: "" };
  } catch {
    return defaultDraft();
  }
}

function persistDraft(draft, stepIndex) {
  try {
    const { logoFile, profileFile, password, ...rest } = draft;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, step: stepIndex }));
  } catch {
    /* ignore */
  }
}

const TITLES = ["Identity", "Location", "Services", "Branding", "Payment setup", "Launch"];

export default function BarberOnboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (typeof j.step === "number" && j.step >= 0 && j.step < STEPS) return j.step;
      }
    } catch {
      /* ignore */
    }
    return 0;
  });
  const [draft, setDraft] = useState(loadDraft);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    persistDraft(draft, step);
  }, [draft, step]);

  const exit = useCallback(() => {
    navigate("/", { replace: true });
  }, [navigate]);

  const goNext = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (step === 0) {
        if (!draft.name.trim() || !draft.email.trim() || !draft.password) {
          throw new Error("Name, email, and password are required.");
        }
        const displayName = (draft.displayName || draft.name).trim();
        const registerBody = {
          name: draft.name.trim(),
          email: draft.email.trim(),
          password: draft.password,
          displayName,
          shopName: draft.shopName.trim() || undefined,
          phone: draft.phone.trim() || undefined,
          bio: draft.bio.trim() || undefined,
        };

        let data;
        try {
          data = await postBarberOnboardRegister(registerBody);
        } catch (err) {
          if (err.httpStatus === 401 && err.payload?.loginRequired) {
            setError("Account exists — please sign in to continue");
            return;
          }
          if (err.duplicateEmail || err.httpStatus === 409) {
            const loginData = await login(draft.email.trim(), draft.password);
            if (!loginData?.token || loginData?.success === false) {
              setError("Account exists — please sign in to continue");
              return;
            }
            localStorage.setItem("token", String(loginData.token));
            if (loginData.user) localStorage.setItem("user", JSON.stringify(loginData.user));
            try {
              data = await postBarberOnboardRegister(registerBody);
            } catch (retryErr) {
              if (retryErr.httpStatus === 401 && retryErr.payload?.loginRequired) {
                setError("Account exists — please sign in to continue");
                return;
              }
              if (retryErr.duplicateEmail || retryErr.httpStatus === 409) {
                setError("Account exists — please sign in to continue");
                return;
              }
              throw retryErr;
            }
          } else {
            throw err;
          }
        }

        console.log("API RESPONSE:", data);
        if (data.token) localStorage.setItem("token", String(data.token));
        if (data.user) localStorage.setItem("user", JSON.stringify(data.user));
        if (data.existing) setNotice("Welcome back — continuing setup.");
        setDraft((d) => ({ ...d, password: "", displayName }));
        setStep(1);
        return;
      }
      if (step === 1) {
        if (!draft.address.trim()) {
          throw new Error("Enter at least a street or city so clients can find you.");
        }
        const lat = draft.latitude.trim() === "" ? null : Number(draft.latitude);
        const lng = draft.longitude.trim() === "" ? null : Number(draft.longitude);
        const location = JSON.stringify({
          address: draft.address.trim(),
          latitude: Number.isFinite(lat) ? lat : null,
          longitude: Number.isFinite(lng) ? lng : null,
        });
        await putBarberProfile({
          name: (draft.displayName || draft.name).trim(),
          shop_name: draft.shopName.trim() || null,
          phone: draft.phone.trim() || null,
          bio: draft.bio.trim() || null,
          location,
        });
        setStep(2);
        return;
      }
      if (step === 2) {
        const list = (draft.services || [])
          .map((r) => ({
            name: String(r.name || "").trim(),
            price: Number(r.price),
            duration_minutes: 30,
          }))
          .filter((r) => r.name && Number.isFinite(r.price) && r.price >= 0);
        if (!list.length) throw new Error("Add at least one service with a name and price.");
        await postOnboardServices(list);
        setStep(3);
        return;
      }
      if (step === 3) {
        if (draft.logoFile) await postBarberMedia("logo", draft.logoFile);
        if (draft.profileFile) await postBarberMedia("profile", draft.profileFile);
        setDraft((d) => ({ ...d, logoFile: null, profileFile: null }));
        setStep(4);
        return;
      }
      if (step === 4) {
        setStep(5);
        return;
      }
      if (step === 5) {
        await postOnboardComplete();
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
        navigate("/website-studio", { replace: true });
        return;
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    setError(null);
    if (step <= 0) {
      exit();
      return;
    }
    setStep((s) => s - 1);
  };

  return (
    <div className="ifcdc-onboarding-root">
      <button type="button" className="ifcdc-onboarding-close" onClick={exit} aria-label="Close onboarding">
        ×
      </button>
      <header className="ifcdc-onboarding-header">
        <div className="ifcdc-onboarding-badge">
          Step {step + 1} of {STEPS}
        </div>
        <div className="ifcdc-onboarding-dots" aria-hidden>
          {TITLES.map((_, i) => (
            <span key={i} className={i === step ? "ifcdc-onboarding-dot ifcdc-onboarding-dot--active" : "ifcdc-onboarding-dot"} />
          ))}
        </div>
        <h1 className="ifcdc-onboarding-title">{TITLES[step]}</h1>
      </header>
      <div className="ifcdc-onboarding-scroll">
        <div key={step} className="ifcdc-onboarding-card ifcdc-onboarding-step">
          {step === 0 ? <StepIdentity draft={draft} setDraft={setDraft} /> : null}
          {step === 1 ? <StepLocation draft={draft} setDraft={setDraft} /> : null}
          {step === 2 ? <StepServices draft={draft} setDraft={setDraft} /> : null}
          {step === 3 ? <StepBranding draft={draft} setDraft={setDraft} /> : null}
          {step === 4 ? <StepPayment /> : null}
          {step === 5 ? <StepLaunch busy={busy} /> : null}

          {notice ? (
            <p className="ifcdc-onboarding-notice" style={{ color: "#7cbe7c", marginTop: 8 }}>
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="ifcdc-onboarding-error">
              {error}{" "}
              <Link to="/login" style={{ textDecoration: "underline", color: "inherit" }}>
                Sign in
              </Link>
            </p>
          ) : null}

          <div className="ifcdc-onboarding-actions">
            <button type="button" className="ifcdc-onboarding-btn ifcdc-onboarding-btn--ghost" onClick={goBack} disabled={busy}>
              {step === 0 ? "Cancel" : "Back"}
            </button>
            <span className="ifcdc-onboarding-spacer" />
            <button type="button" className="ifcdc-onboarding-btn" onClick={() => void goNext()} disabled={busy}>
              {step === 5 ? (busy ? "Publishing…" : "Go live") : busy ? "Please wait…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
