import { useEffect } from "react";
import { getApiOrigin } from "../services/api.js";
import {
  clearAuthSession,
  getStoredToken,
  persistAuthSession,
} from "../lib/authHeaders.js";

/**
 * On boot / tab focus, refresh `/api/auth/me` so web sessions stay aligned with
 * mobile management fields (isManager, shopIds, permissions, status).
 */
export default function AuthSessionHydrate() {
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const token = getStoredToken();
      if (!token) return;
      try {
        const origin = getApiOrigin();
        const res = await fetch(`${origin}/api/auth/me`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          clearAuthSession();
          return;
        }
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data?.token || data?.user) {
          persistAuthSession({
            token: data.token || token,
            user: data.user,
          });
        }
      } catch {
        /* non-fatal — offline / cold start */
      }
    }

    void hydrate();
    const onFocus = () => void hydrate();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return null;
}
