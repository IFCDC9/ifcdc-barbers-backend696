import { useEffect, useState } from "react";
import { getApiOrigin } from "../services/api.js";
import { resolveDisplayBusinessPhone } from "../lib/publicBusinessPhone.js";

/**
 * Loads public business phone: shop DB first (`/api/config`), then `VITE_BUSINESS_PHONE` fallback.
 * @param {{ businessId?: string|number|null }} [opts]
 */
export function usePublicBusinessPhone(opts = {}) {
  const businessId = opts.businessId != null && opts.businessId !== "" ? String(opts.businessId) : "";
  const [phone, setPhone] = useState(() => resolveDisplayBusinessPhone(""));
  const [auraPhone, setAuraPhone] = useState("");
  const [phoneSource, setPhoneSource] = useState("loading");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const origin = getApiOrigin();
    const q = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";

    setLoading(true);
    setError(null);

    fetch(`${origin}/api/config${q}`, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
        }
        if (!cancelled) {
          setPhone(resolveDisplayBusinessPhone(data?.phone));
          setAuraPhone(data?.auraPhone != null ? String(data.auraPhone).trim() : "");
          setPhoneSource(String(data?.phoneSource || (data?.phone ? "shop" : "platform_fallback")).trim() || "unknown");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || "Could not load phone number");
          setPhone(resolveDisplayBusinessPhone(""));
          setPhoneSource("error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [businessId]);

  return { phone, auraPhone, phoneSource, loading, error };
}
