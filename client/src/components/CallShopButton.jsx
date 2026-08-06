import { formatNanpUsDisplay, nanpDialString } from "../lib/formatNanp.js";

/**
 * Visible shop / platform telephone CTA.
 * Uses tel:+1XXXXXXXXXX under the hood; displays (XXX) XXX-XXXX.
 */
export default function CallShopButton({
  phoneE164,
  shopName = null,
  className = "",
  variant = "primary",
}) {
  const dial = nanpDialString(phoneE164 || "+19895141064");
  const display = formatNanpUsDisplay(phoneE164 || "+19895141064") || "(989) 514-1064";
  const label = shopName ? `Call ${shopName}` : "Call IFCDC Barbers App";

  if (!dial) return null;

  return (
    <div className={`call-shop-button call-shop-button--${variant} ${className}`.trim()}>
      <p className="call-shop-button__number" aria-label={`Telephone ${display}`}>
        <span aria-hidden>☎️</span> {display}
      </p>
      <a className="call-shop-button__cta" href={`tel:${dial}`}>
        <span aria-hidden>☎️</span> {label}
      </a>
    </div>
  );
}
