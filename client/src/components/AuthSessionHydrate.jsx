import { createContext, useContext, useEffect, useState } from "react";
import { getStoredToken } from "../lib/authHeaders.js";
import { hydrateAuthSessionFromMe } from "../lib/authMe.js";

const AuthSessionGenerationContext = createContext(0);

/** Bumps when /me writes a fresh user so nav/profile re-read localStorage. */
export function useAuthSessionGeneration() {
  return useContext(AuthSessionGenerationContext);
}

/**
 * On boot, tab focus, and visibility, refresh `/api/auth/me` so a Super Admin
 * role change (e.g. shop_manager → platform_manager) is picked up without
 * waiting for a 30-day JWT to expire.
 */
export default function AuthSessionHydrate({ children }) {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const token = getStoredToken();
      if (!token) return;
      const before = window.localStorage.getItem("user");
      await hydrateAuthSessionFromMe({ token });
      if (cancelled) return;
      const after = window.localStorage.getItem("user");
      if (after !== before) setGeneration((n) => n + 1);
    }

    void hydrate();
    const onFocus = () => void hydrate();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void hydrate();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <AuthSessionGenerationContext.Provider value={generation}>
      {children}
    </AuthSessionGenerationContext.Provider>
  );
}
