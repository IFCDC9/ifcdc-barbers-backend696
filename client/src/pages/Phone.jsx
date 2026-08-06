import { useState } from "react";
import { formatNanpUsDisplay, nanpDialString } from "../lib/formatNanp.js";
import { useDevice } from "../hooks/useDevice.js";
import { usePublicBusinessPhone } from "../hooks/usePublicBusinessPhone.js";
import CallShopButton from "../components/CallShopButton.jsx";

export default function Phone() {
  const device = useDevice();
  const {
    phone: phoneNumber,
    auraPhone,
    callButtonLabel,
    shopName,
    loading,
    error: loadError,
  } = usePublicBusinessPhone();
  const [copied, setCopied] = useState(false);

  const effectivePhone = phoneNumber || auraPhone || "+19895141064";

  const callNow = () => {
    const dial = nanpDialString(effectivePhone);
    if (!dial) return;
    window.location.href = `tel:${dial}`;
  };

  const copyNumber = async () => {
    const toCopy = nanpDialString(effectivePhone) || effectivePhone;
    try {
      await navigator.clipboard.writeText(toCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      window.prompt("Copy phone number:", toCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };

  const displayPhone = formatNanpUsDisplay(effectivePhone);
  const auraPhoneFormatted = formatNanpUsDisplay(auraPhone || "+19895141064");

  return (
    <div className="page phone-page">
      <h1 className="phone-page__title">
        <span className="phone-page__title-icon" aria-hidden>
          ☎
        </span>
        <span className="phone-page__title-text">Phone</span>
      </h1>
      <p className="phone-page__lead">
        Call {shopName || "IFCDC Barbers App"} — tap the button to open the dialer on your device.
      </p>

      {loading ? <p className="phone-page__status">Loading…</p> : null}
      {loadError ? <p className="phone-page__status phone-page__status--warn">{loadError}</p> : null}

      {!loading ? (
        <>
          <CallShopButton phoneE164={effectivePhone} shopName={shopName || null} />
          <p className="phone-page__label">Business number</p>
          <p className="phone-page__number" aria-live="polite">
            ☎️ {displayPhone || "—"}
          </p>
          <div className={`phone-page__actions phone-page__actions--${device}`}>
            <button type="button" className="phone-page__cta" onClick={callNow}>
              ☎️ {callButtonLabel || "Call IFCDC Barbers App"}
            </button>
            {device === "desktop" ? (
              <button type="button" className="phone-page__cta phone-page__cta--ghost" onClick={copyNumber}>
                {copied ? "Copied" : "Copy"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="ai-box">
        <h2>Need help?</h2>
        <p>
          Tap the floating <strong className="phone-page__aura-name">AURA</strong> button (bottom-right) for booking help and
          answers.
        </p>
        <div className="phone-page__aura-contact-block">
          <p className="phone-page__aura-contact">
            <a href={`tel:${nanpDialString(auraPhone || "+19895141064")}`} className="phone-page__aura-contact-link">
              Call AURA
            </a>
            {" · "}
            <a href={`sms:${nanpDialString(auraPhone || "+19895141064")}`} className="phone-page__aura-contact-link">
              Text AURA
            </a>
          </p>
          {auraPhoneFormatted ? (
            <p className="phone-page__aura-display" aria-label={`IFCDC Barbers App ${auraPhoneFormatted}`}>
              IFCDC Barbers App · {auraPhoneFormatted}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
