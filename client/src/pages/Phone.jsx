import { usePublicBusinessPhone } from "../hooks/usePublicBusinessPhone.js";
import CallShopButton from "../components/CallShopButton.jsx";

export default function Phone() {
  const {
    phone: phoneNumber,
    auraPhone,
    shopName,
    loading,
    error: loadError,
  } = usePublicBusinessPhone();

  const effectivePhone = phoneNumber || auraPhone || "+19895141064";

  return (
    <div className="page phone-page">
      <h1 className="phone-page__title">
        <span className="phone-page__title-text">Phone</span>
      </h1>
      <p className="phone-page__lead">
        Call {shopName || "IFCDC Barbers App"} — tap the line below to open the dialer.
      </p>

      {loading ? <p className="phone-page__status">Loading…</p> : null}
      {loadError ? <p className="phone-page__status phone-page__status--warn">{loadError}</p> : null}

      {!loading ? (
        <CallShopButton phoneE164={effectivePhone} shopName={shopName || null} />
      ) : null}

      <div className="ai-box">
        <h2>Need help?</h2>
        <p>
          Tap the floating <strong className="phone-page__aura-name">AURA</strong> button (bottom-right) for booking
          help and answers.
        </p>
      </div>
    </div>
  );
}
