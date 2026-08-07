import { useEffect, useState } from "react";
import { apiFullUrl } from "../constants/config";
import { useAuth } from "../services/authContext";
import {
  DEFAULT_AURA_PHONE_DISPLAY,
  DEFAULT_AURA_PHONE_E164,
  formatUsPhoneDisplay,
  toAuraTelHref,
} from "../utils/auraPhone";

export type AuraCallPhoneState = {
  loading: boolean;
  phoneE164: string;
  display: string;
  shopName: string | null;
  telHref: string;
};

/**
 * Loads shop-aware AURA / public phone from GET /api/config.
 * Defaults to IFCDC +19895141064 when config is unavailable.
 */
export function useAuraCallPhone(): AuraCallPhoneState {
  const { user } = useAuth();
  const businessId = user?.businessId != null && user.businessId !== "" ? String(user.businessId) : "";
  const [state, setState] = useState<AuraCallPhoneState>({
    loading: true,
    phoneE164: DEFAULT_AURA_PHONE_E164,
    display: DEFAULT_AURA_PHONE_DISPLAY,
    shopName: null,
    telHref: `tel:${DEFAULT_AURA_PHONE_E164}`,
  });

  useEffect(() => {
    let cancelled = false;
    const q = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";
    const url = apiFullUrl(`/api/config${q}`);

    (async () => {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || cancelled) return;
        const rawPhone =
          String(data.phone || data.auraPhone || data.platformSharedNumber || DEFAULT_AURA_PHONE_E164).trim() ||
          DEFAULT_AURA_PHONE_E164;
        const telHref = String(data.callTelHref || "").trim() || toAuraTelHref(rawPhone);
        const display =
          String(data.phoneDisplay || "").trim() || formatUsPhoneDisplay(rawPhone) || DEFAULT_AURA_PHONE_DISPLAY;
        const shopName = data.shopName ? String(data.shopName) : null;
        if (!cancelled) {
          setState({
            loading: false,
            phoneE164: rawPhone.startsWith("+") ? rawPhone : DEFAULT_AURA_PHONE_E164,
            display,
            shopName,
            telHref: telHref.startsWith("tel:") ? telHref : toAuraTelHref(rawPhone),
          });
        }
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [businessId]);

  return state;
}
