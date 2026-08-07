import { formatNanpUsDisplay, nanpDialString } from "../lib/formatNanp.js";

/**
 * Single AURA telephone CTA — one icon, one number, one tel: link.
 * Default: ☎️ Call AURA: (989) 514-1064
 * Multi-shop: ☎️ Call AURA at [Shop Name]: (XXX) XXX-XXXX
 */
export function buildCallAuraLabel(shopName, displayPhone) {
  const display = String(displayPhone || "").trim() || "(989) 514-1064";
  const name = String(shopName || "").trim();
  const isDefaultIfcdc = !name || /^ifcdc\s+barbers(\s+app)?$/i.test(name);
  if (isDefaultIfcdc) return `☎️ Call AURA: ${display}`;
  return `☎️ Call AURA at ${name}: ${display}`;
}

export default function CallShopButton({
  phoneE164,
  shopName = null,
  className = "",
  variant = "primary",
}) {
  const dial = nanpDialString(phoneE164 || "+19895141064") || "+19895141064";
  const display = formatNanpUsDisplay(phoneE164 || "+19895141064") || "(989) 514-1064";
  const label = buildCallAuraLabel(shopName, display);

  return (
    <div className={`call-shop-button call-shop-button--${variant} ${className}`.trim()}>
      <a
        className="call-shop-button__line"
        href={`tel:${dial}`}
        aria-label={label.replace(/^☎️\s*/, "")}
      >
        {label}
      </a>
    </div>
  );
}
